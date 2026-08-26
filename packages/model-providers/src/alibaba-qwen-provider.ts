import { performance } from "node:perf_hooks";

import {
  garmentAnalysisSchema,
  type GarmentAnalysisBrief,
  type GarmentAnalysisProviderInput,
  type GarmentAnalysisProviderResult,
  type ProviderUsage,
  type SourceImageInput,
} from "@cloth-idea/domain";
import { z } from "zod";

import type { GarmentAnalysisProvider } from "./garment-analysis-provider";
import { GarmentProviderError, type ProviderErrorCode } from "./garment-image-provider";

type FetchImplementation = typeof fetch;

export interface AlibabaQwenProviderConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model?: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImplementation?: FetchImplementation;
}

const qwenResponseSchema = z.object({
  id: z.string().optional(),
  choices: z.array(
    z.object({
      message: z.object({ content: z.string() }),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function toDataUrl(input: SourceImageInput): string {
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
      throw new GarmentProviderError("PROVIDER_TIMEOUT", "服装视觉分析超时，请稍后重试。", {
        cause: error,
        retryable: true,
      });
    }
    throw new GarmentProviderError("PROVIDER_UNAVAILABLE", "无法连接服装视觉分析服务。", {
      cause: error,
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildAnalysisPrompt(brief: GarmentAnalysisBrief): string {
  return [
    "你是一名严谨的服装设计师、打版师和商品企划。请分析输入的单张服装图，并只返回 JSON。",
    "严格遵守 garment-dna-v0.2：visualFacts 必须包含 category、silhouette、length、shoulder、collar、closure、sleeve、cuff、pockets、frontPanels、backPanels、fabric、color、trims、craftsmanship、presentation。",
    "每个 visualFacts 项都必须是 {value, evidenceLevel, confidence, evidence}。value 只能为字符串、字符串数组或 null；evidenceLevel 只能为 visible、inferred、unknown；confidence 为 0 到 1。",
    "证据纪律：只有能在当前图片中直接定位的内容才标 visible；无法看到的后片、内里、尺寸、纤维成分、版型数据不得猜测，必须标 inferred 或 unknown。衣架商品图不得推断人体穿着长度和合体度。",
    "用户要求和图片事实必须分开。不得把用户希望新增的结构写成原款 visualFacts。",
    "输出 userConstraints: {preserve, modify, avoid}；conflictsOrQuestions；恰好 3 个 designDirections；recommendedDirectionId；recommendationReason。",
    "每个 designDirections 项必须包含：id(direction-1/2/3)、name、summary、changes(至少2项)、preserve、productionRisk、promptRequirements。",
    "changes 每项为 {area, instruction, reason}，area 只能从 silhouette、proportion、shoulder、collar、closure、sleeve、cuff、pockets、panels、fabric、color、trims、craftsmanship、presentation 中选择。",
    "productionRisk 为 {level,newPatternPieces,newTrims,newOperations,fitOrStructureRisks,reason}。promptRequirements 为 {positive,hardConstraints,negative}。所有字段都必须存在，不要输出 Markdown 代码块。",
    `业务模式：${brief.mode === "inspiration" ? "设计灵感探索" : "服装档口快速衍生"}`,
    `必须保留：${brief.preserveItems.join("、") || "未指定"}`,
    `想怎么改：${brief.changeRequest}`,
    `目标风格：${brief.styleDirection}`,
    `改款幅度：${brief.intensity}`,
  ].join("\n");
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

function toUsage(usage: z.infer<typeof qwenResponseSchema>["usage"]): ProviderUsage {
  return {
    generatedImages: 0,
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    size: null,
  };
}

export class AlibabaQwenProvider implements GarmentAnalysisProvider {
  readonly provider = "alibaba-qwen-vl" as const;
  readonly model: string;
  readonly configured = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly requestTimeoutMs: number;

  constructor(config: AlibabaQwenProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.model = config.model ?? "qwen3-vl-plus";
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 150_000;
  }

  async analyze(input: GarmentAnalysisProviderInput): Promise<GarmentAnalysisProviderResult> {
    const startedAt = performance.now();
    const response = await fetchWithTimeout(
      this.fetchImplementation,
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: buildAnalysisPrompt(input.brief) },
                { type: "image_url", image_url: { url: toDataUrl(input.sourceImage) } },
              ],
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 5_000,
        }),
      },
      this.requestTimeoutMs,
    );

    const rawPayload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const mappedError = mapHttpError(response.status);
      throw new GarmentProviderError(mappedError.code, "服装视觉分析服务拒绝了本次请求。", {
        retryable: mappedError.retryable,
      });
    }

    const parsedResponse = qwenResponseSchema.safeParse(rawPayload);
    if (!parsedResponse.success) {
      throw new GarmentProviderError(
        "PROVIDER_BAD_RESPONSE",
        "服装视觉分析服务返回了无法识别的结果。",
        { cause: parsedResponse.error },
      );
    }

    const content = parsedResponse.data.choices[0]?.message.content;
    if (!content) {
      throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "服装视觉分析结果为空。", {
        requestId: parsedResponse.data.id,
      });
    }

    let rawAnalysis: unknown;
    try {
      rawAnalysis = JSON.parse(stripJsonFence(content));
    } catch (error) {
      throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "服装视觉分析不是有效 JSON。", {
        cause: error,
        requestId: parsedResponse.data.id,
      });
    }

    const parsedAnalysis = garmentAnalysisSchema.safeParse(rawAnalysis);
    if (!parsedAnalysis.success) {
      throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "服装视觉分析未通过结构校验。", {
        cause: parsedAnalysis.error,
        requestId: parsedResponse.data.id,
      });
    }

    return {
      provider: this.provider,
      model: this.model,
      providerRequestId: parsedResponse.data.id ?? null,
      durationMs: Math.round(performance.now() - startedAt),
      usage: toUsage(parsedResponse.data.usage),
      analysis: parsedAnalysis.data,
    };
  }
}
