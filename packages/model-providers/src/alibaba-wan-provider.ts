import { performance } from "node:perf_hooks";

import {
  buildGarmentPrompt,
  type GarmentGenerationInput,
  type GarmentGenerationResult,
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

export interface AlibabaWanProviderConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model?: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImplementation?: FetchImplementation;
}

const wanResponseSchema = z
  .object({
    output: z
      .object({
        choices: z.array(
          z.object({
            message: z.object({
              content: z.array(
                z.object({
                  type: z.string(),
                  image: z.string().optional(),
                }),
              ),
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
        size: z.string().optional(),
      })
      .optional(),
    request_id: z.string().optional(),
    requestId: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function toDataUrl(input: GarmentGenerationInput["sourceImage"]): string {
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
      throw new GarmentProviderError("PROVIDER_TIMEOUT", "模型请求超时，请稍后重试。", {
        cause: error,
        retryable: true,
      });
    }
    throw new GarmentProviderError("PROVIDER_UNAVAILABLE", "无法连接生图服务。", {
      cause: error,
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function toUsage(usage: z.infer<typeof wanResponseSchema>["usage"]): ProviderUsage {
  return {
    generatedImages: usage?.image_count ?? 1,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    size: usage?.size ?? null,
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

export class AlibabaWanProvider implements GarmentImageProvider {
  readonly provider = "alibaba-wan" as const;
  readonly model: string;
  readonly configured = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly requestTimeoutMs: number;

  constructor(config: AlibabaWanProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.model = config.model ?? "wan2.7-image-pro";
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 120_000;
  }

  async generateVariation(input: GarmentGenerationInput): Promise<GarmentGenerationResult> {
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
                  { text: buildGarmentPrompt(input) },
                  { image: toDataUrl(input.sourceImage) },
                ],
              },
            ],
          },
          parameters: {
            size: "2K",
            n: input.outputCount,
            watermark: false,
            enable_interleave: false,
            prompt_extend: true,
          },
        }),
      },
      this.requestTimeoutMs,
    );

    const rawPayload: unknown = await response.json().catch(() => null);
    const parsedPayload = wanResponseSchema.safeParse(rawPayload);
    const requestId = parsedPayload.success
      ? (parsedPayload.data.request_id ?? parsedPayload.data.requestId)
      : undefined;

    if (!response.ok) {
      const mappedError = mapHttpError(response.status);
      throw new GarmentProviderError(mappedError.code, "生图服务拒绝了本次请求。", {
        requestId,
        retryable: mappedError.retryable,
      });
    }

    if (!parsedPayload.success) {
      throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "生图服务返回了无法识别的结果。", {
        cause: parsedPayload.error,
        requestId,
      });
    }

    const payload = parsedPayload.data;
    if (payload.code) {
      throw new GarmentProviderError("PROVIDER_REJECTED_INPUT", "生图任务未能完成。", {
        requestId,
      });
    }

    const imageUrl = payload.output?.choices
      .flatMap((choice) => choice.message.content)
      .find((content) => content.type === "image" && content.image)?.image;

    if (!imageUrl) {
      throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "生图结果中没有图片。", {
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
      throw new GarmentProviderError("PROVIDER_UNAVAILABLE", "图片生成成功，但结果下载失败。", {
        requestId,
        retryable: true,
      });
    }

    const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());

    return {
      provider: this.provider,
      model: this.model,
      providerRequestId: requestId ?? null,
      durationMs: Math.round(performance.now() - startedAt),
      assets: [
        {
          bytes: imageBytes,
          mimeType: parseImageMimeType(imageResponse.headers.get("content-type")),
        },
      ],
      usage: toUsage(payload.usage),
    };
  }
}
