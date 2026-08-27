import { performance } from "node:perf_hooks";

import {
  type GarmentGenerationResult,
  type GarmentImageProviderInput,
  type ProviderUsage,
  type SupportedImageMimeType,
} from "@cloth-idea/domain";
import { z } from "zod";

import {
  GarmentProviderError,
  type GarmentImageProvider,
  type ProviderErrorCode,
} from "./garment-image-provider";

type FetchImplementation = typeof fetch;

export interface AlibabaQwenImageProviderConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model?: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImplementation?: FetchImplementation;
}

const qwenImageResponseSchema = z
  .object({
    output: z
      .object({
        choices: z.array(
          z.object({
            message: z.object({
              content: z.array(z.object({ image: z.string().optional() }).passthrough()),
            }),
          }),
        ),
      })
      .optional(),
    usage: z
      .object({
        image_count: z.number().optional(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      })
      .optional(),
    request_id: z.string().optional(),
    requestId: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const sourceTextRemovalInstruction =
  "输入图里的商家型号、货号、价格、联系方式、贴纸文字和水印只属于拍摄背景，必须从结果中完全删除；不得临摹、改写、替换或新增任何可读文字。";

const negativePrompt = [
  "商家型号",
  "货号",
  "价格",
  "联系方式",
  "品牌标志",
  "贴纸文字",
  "水印",
  "字幕",
  "任何可读文字",
  "背面视角",
  "重复部件",
  "结构矛盾",
  "悬空缝线",
  "不可制作的装饰",
].join("、");

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function toDataUrl(input: GarmentImageProviderInput["sourceImage"]): string {
  return `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`;
}

function mapHttpError(status: number): { code: ProviderErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) {
    return { code: "PROVIDER_AUTH_FAILED", retryable: false };
  }
  if (status === 429) {
    return { code: "PROVIDER_RATE_LIMITED", retryable: true };
  }
  if (status >= 400 && status < 500) {
    return { code: "PROVIDER_REJECTED_INPUT", retryable: false };
  }
  return { code: "PROVIDER_UNAVAILABLE", retryable: true };
}

async function fetchWithTimeout(
  fetchImplementation: FetchImplementation,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImplementation(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new GarmentProviderError("PROVIDER_TIMEOUT", "千问生图请求超时，请稍后重试。", {
        cause: error,
        retryable: true,
      });
    }
    throw new GarmentProviderError("PROVIDER_UNAVAILABLE", "无法连接千问生图服务。", {
      cause: error,
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function toUsage(usage: z.infer<typeof qwenImageResponseSchema>["usage"]): ProviderUsage {
  return {
    generatedImages: usage?.image_count ?? 1,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    size: usage?.width && usage.height ? `${usage.width}*${usage.height}` : null,
  };
}

function parseImageMimeType(contentType: string | null): SupportedImageMimeType {
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) {
    return "image/jpeg";
  }
  if (contentType?.includes("webp")) {
    return "image/webp";
  }
  return "image/png";
}

export class AlibabaQwenImageProvider implements GarmentImageProvider {
  readonly provider = "alibaba-qwen-image" as const;
  readonly model: string;
  readonly configured = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly requestTimeoutMs: number;

  constructor(config: AlibabaQwenImageProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.model = config.model ?? "qwen-image-2.0-pro-2026-06-22";
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 150_000;
  }

  async generateVariation(input: GarmentImageProviderInput): Promise<GarmentGenerationResult> {
    const startedAt = performance.now();
    const response = await fetchWithTimeout(
      this.fetchImplementation,
      `${this.baseUrl}/services/aigc/multimodal-generation/generation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: {
            messages: [
              {
                role: "user",
                content: [
                  ...(input.referenceImages ?? []).map((image) => ({ image: toDataUrl(image) })),
                  { image: toDataUrl(input.sourceImage) },
                  { text: `${input.prompt}\n\n${sourceTextRemovalInstruction}` },
                ],
              },
            ],
          },
          parameters: {
            n: input.outputCount,
            negative_prompt: negativePrompt,
            prompt_extend: false,
            watermark: false,
          },
        }),
      },
      this.requestTimeoutMs,
    );

    const rawPayload: unknown = await response.json().catch(() => null);
    const parsedPayload = qwenImageResponseSchema.safeParse(rawPayload);
    const requestId = parsedPayload.success
      ? (parsedPayload.data.request_id ?? parsedPayload.data.requestId)
      : undefined;

    if (!response.ok) {
      const mappedError = mapHttpError(response.status);
      throw new GarmentProviderError(mappedError.code, "千问生图服务拒绝了本次请求。", {
        requestId,
        retryable: mappedError.retryable,
      });
    }
    if (!parsedPayload.success) {
      throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "千问生图返回了无法识别的结果。", {
        cause: parsedPayload.error,
        requestId,
      });
    }
    if (parsedPayload.data.code) {
      throw new GarmentProviderError("PROVIDER_REJECTED_INPUT", "千问生图任务未能完成。", {
        requestId,
      });
    }

    const imageUrl = parsedPayload.data.output?.choices
      .flatMap((choice) => choice.message.content)
      .find((content) => content.image)?.image;
    if (!imageUrl) {
      throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "千问生图结果中没有图片。", {
        requestId,
      });
    }

    const imageResponse = await fetchWithTimeout(
      this.fetchImplementation,
      imageUrl,
      { method: "GET" },
      this.requestTimeoutMs,
    );
    if (!imageResponse.ok) {
      throw new GarmentProviderError("PROVIDER_UNAVAILABLE", "千问生图成功，但结果下载失败。", {
        requestId,
        retryable: true,
      });
    }

    return {
      provider: this.provider,
      model: this.model,
      providerRequestId: requestId ?? null,
      durationMs: Math.round(performance.now() - startedAt),
      assets: [
        {
          bytes: new Uint8Array(await imageResponse.arrayBuffer()),
          mimeType: parseImageMimeType(imageResponse.headers.get("content-type")),
        },
      ],
      usage: toUsage(parsedPayload.data.usage),
    };
  }
}
