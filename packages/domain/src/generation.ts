export const generationModes = ["inspiration", "quick-derivative"] as const;
export type GenerationMode = (typeof generationModes)[number];

export const designIntensities = ["low", "medium", "high"] as const;
export type DesignIntensity = (typeof designIntensities)[number];

export const supportedImageMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type SupportedImageMimeType = (typeof supportedImageMimeTypes)[number];

export const generationPromptVersions = [
  "garment-redesign-v1",
  "garment-analysis-v1",
  "garment-iteration-v1",
] as const;
export type GenerationPromptVersion = (typeof generationPromptVersions)[number];

export const generationOperations = ["initial", "regenerate", "refine"] as const;
export type GenerationOperation = (typeof generationOperations)[number];

export interface SourceImageInput {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: SupportedImageMimeType;
}

export interface GarmentGenerationInput {
  readonly mode: GenerationMode;
  readonly preserveItems: readonly string[];
  readonly changeRequest: string;
  readonly styleDirection: string;
  readonly intensity: DesignIntensity;
  readonly sourceImage: SourceImageInput;
  readonly outputCount: 1;
  readonly promptVersion: GenerationPromptVersion;
}

export interface GarmentImageProviderInput {
  readonly sourceImage: SourceImageInput;
  readonly prompt: string;
  readonly outputCount: 1;
  readonly promptVersion: GarmentGenerationInput["promptVersion"];
}

export interface GeneratedImageAsset {
  readonly bytes: Uint8Array;
  readonly mimeType: SupportedImageMimeType;
}

export interface ProviderUsage {
  readonly generatedImages: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly size: string | null;
}

export interface GarmentGenerationResult {
  readonly provider: "alibaba-wan" | "alibaba-qwen-image" | "volcengine-seedream";
  readonly model: string;
  readonly providerRequestId: string | null;
  readonly durationMs: number;
  readonly assets: readonly GeneratedImageAsset[];
  readonly usage: ProviderUsage;
}

export interface GenerationApiResponse {
  readonly jobId: string;
  readonly status: "succeeded";
  readonly provider: GarmentGenerationResult["provider"];
  readonly model: string;
  readonly resultUrl: string;
  readonly summary: string;
  readonly durationMs: number;
  readonly strategy: "direct" | "analyzed";
  readonly directionId: string | null;
  readonly directionName: string | null;
  readonly operation: GenerationOperation;
  readonly parentJobId: string | null;
  readonly revisionInstruction: string | null;
  readonly createdAt: string;
}

export interface ApiErrorResponse {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly retryable: boolean;
}

const modeInstructions: Record<GenerationMode, string> = {
  inspiration:
    "这是设计师灵感探索任务。允许明显改变廓形、结构、工艺与辅料，但所有变化必须形成统一设计语言。",
  "quick-derivative":
    "这是服装档口快速衍生任务。优先保证结构可打版、工艺可实现、成本可控，并保留原款的商业识别度。",
};

const intensityInstructions: Record<DesignIntensity, string> = {
  low: "改款幅度较低：保持主要廓形，只调整关键结构、部件、工艺和辅料。",
  medium: "改款幅度中等：允许调整廓形比例和多个结构区域，但仍能看出原款来源。",
  high: "改款幅度较高：可重新组织廓形、结构和工艺系统，但必须遵守所有保留项。",
};

export function buildGarmentPrompt(input: GarmentGenerationInput): string {
  const preserveInstruction =
    input.preserveItems.length > 0
      ? `必须完整保留：${input.preserveItems.join("、")}。这些是硬约束，不得弱化、替换或扩散到其他区域。`
      : "用户没有指定硬性保留项，但仍应保持服装品类、商品图主体和合理结构。";

  return [
    "你是一名熟悉服装设计、打版与工艺的专业设计师。请基于输入服装图片完成整体改款。",
    modeInstructions[input.mode],
    intensityInstructions[input.intensity],
    preserveInstruction,
    `主要修改要求：${input.changeRequest.trim()}。`,
    `目标风格：${input.styleDirection.trim()}。`,
    "改款不应只停留在领型或口袋替换；需要综合考虑廓形、比例、结构线、分割、面料、拼接、工艺、辅料与色彩关系。",
    "保持原图的服装商品摄影属性、主体完整性和合理穿着结构。输出应具有真实面料纹理与清晰缝制逻辑，可以用于选款和进一步打样沟通。",
    "避免人物、品牌标志、无关文字、额外水印、结构矛盾、重复部件、悬空缝线和不可制作的装饰。",
  ].join("\n");
}

export function createGenerationSummary(input: GarmentGenerationInput): string {
  const modeLabel = input.mode === "inspiration" ? "灵感设计" : "快速衍生";
  const preserveLabel =
    input.preserveItems.length > 0 ? input.preserveItems.join("、") : "原款品类与主体";

  return `${modeLabel} · 保留 ${preserveLabel} · ${input.styleDirection.trim()}`;
}
