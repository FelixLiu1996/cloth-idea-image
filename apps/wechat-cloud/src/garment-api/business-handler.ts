import { createHash, randomUUID } from "node:crypto";

import {
  ApplicationStateConflictError,
  GenerationTaskAdmissionService,
  GenerationTaskExecutionService,
  IdempotencyConflictError,
  TrialQuotaExceededError,
  type GarmentAnalysisRepository,
  type GarmentAssetRepository,
  type GenerationTaskRecord,
  type GenerationTaskRepository,
  type IdempotencyRepository,
  type TrialQuotaRepository,
  type ApplicationTransactionRunner,
} from "@cloth-idea/application";
import {
  applyEvidenceGate,
  buildGarmentPrompt,
  compileAnalyzedGarmentPrompt,
  compileGarmentIterationPrompt,
  createGenerationSummary,
  findDesignDirection,
  garmentAnalysisSchema,
  supportedImageMimeTypes,
  type ApiErrorResponse,
  type CreateWechatCloudGarmentAnalysisRequest,
  type CreateWechatCloudGenerationRequest,
  type CreateWechatCloudRefinementRequest,
  type GarmentAnalysis,
  type GarmentAnalysisApiResponse,
  type GarmentAnalysisBrief,
  type GarmentAnalysisProviderResult,
  type GarmentGenerationInput,
  type GarmentGenerationResult,
  type GenerationApiResponse,
  type GenerationJobFailedResponse,
  type GenerationJobStatusResponse,
  type GenerationPromptVersion,
  type SourceImageInput,
  type SupportedImageMimeType,
  type WechatCloudBusinessRequest,
  type WechatCloudResponse,
  type WechatCloudSourceImageReference,
} from "@cloth-idea/domain";
import {
  GarmentProviderError,
  type GarmentAnalysisProvider,
  type GarmentImageProvider,
} from "@cloth-idea/model-providers";

import type { WechatCloudGarmentAssetStorage } from "./cloud-asset-storage";
import type { GarmentCloudBusinessProviderMode } from "./provider-config";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const allowedMimeTypes = new Set<string>(supportedImageMimeTypes);
const businessActions = new Set<string>([
  "analyze-garment",
  "create-generation",
  "create-refinement",
  "get-generation-job",
]);

export interface GarmentCloudBusinessPersistence {
  readonly transactions: ApplicationTransactionRunner;
  readonly analyses: GarmentAnalysisRepository;
  readonly assets: GarmentAssetRepository;
  readonly tasks: GenerationTaskRepository;
  readonly idempotency: IdempotencyRepository;
  readonly quotas: TrialQuotaRepository;
}

export interface GarmentCloudBusinessHandlerDependencies {
  readonly getOpenId: () => string | undefined;
  readonly isTrialMember: (viewerFingerprint: string) => Promise<boolean>;
  readonly persistence: GarmentCloudBusinessPersistence;
  readonly storage: Pick<WechatCloudGarmentAssetStorage, "read" | "save">;
  readonly providerMode: GarmentCloudBusinessProviderMode;
  readonly analysisProvider?: GarmentAnalysisProvider | null;
  readonly imageProvider?: GarmentImageProvider | null;
  readonly providerConfigurationError?: string | null;
  readonly logEvent?: (event: Readonly<Record<string, unknown>>) => void;
  readonly now: () => string;
  readonly createResourceId?: () => string;
  readonly createRequestId?: () => string;
  readonly trialDailyAnalysisLimit: number;
  readonly trialDailyGenerationLimit: number;
  readonly globalDailyAnalysisLimit: number;
  readonly globalDailyGenerationLimit: number;
  readonly assetRetentionHours: number;
  readonly executionLeaseSeconds?: number;
  readonly fakeGenerationDelayMs?: number;
  readonly maxRefinementDepth?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(value: string, length = 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function viewerFingerprint(openId: string): string {
  return hash(openId, 16);
}

function addHours(value: string, hours: number): string {
  return new Date(Date.parse(value) + hours * 60 * 60 * 1_000).toISOString();
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1_000).toISOString();
}

function interruptedExecutionError(
  dependencies: GarmentCloudBusinessHandlerDependencies,
): ApiErrorResponse {
  return {
    code: "GENERATION_EXECUTION_INTERRUPTED",
    message: "生成执行曾在模型调用后中断，已停止自动重试以避免重复计费。",
    requestId: (dependencies.createRequestId ?? randomUUID)(),
    retryable: false,
  };
}

function dayOf(value: string): string {
  return value.slice(0, 10);
}

function apiError(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  code: string,
  message: string,
  retryable: boolean,
): WechatCloudResponse {
  const error: ApiErrorResponse = {
    code,
    message,
    requestId: (dependencies.createRequestId ?? randomUUID)(),
    retryable,
  };
  return { ok: false, error };
}

function parseBrief(value: unknown): GarmentAnalysisBrief | null {
  if (
    !isRecord(value) ||
    (value.mode !== "inspiration" && value.mode !== "quick-derivative") ||
    !Array.isArray(value.preserveItems) ||
    value.preserveItems.length > 16 ||
    !value.preserveItems.every(
      (item) => typeof item === "string" && item.trim().length > 0 && item.length <= 500,
    ) ||
    typeof value.changeRequest !== "string" ||
    value.changeRequest.trim().length < 2 ||
    value.changeRequest.length > 1_000 ||
    typeof value.styleDirection !== "string" ||
    value.styleDirection.trim().length < 2 ||
    value.styleDirection.length > 500 ||
    (value.intensity !== "low" && value.intensity !== "medium" && value.intensity !== "high")
  ) {
    return null;
  }
  return {
    mode: value.mode,
    preserveItems: value.preserveItems as string[],
    changeRequest: value.changeRequest,
    styleDirection: value.styleDirection,
    intensity: value.intensity,
  };
}

function parseImageReference(
  value: Record<string, unknown>,
): WechatCloudSourceImageReference | null {
  if (
    typeof value.idempotencyKey !== "string" ||
    typeof value.cloudFileId !== "string" ||
    typeof value.fileName !== "string" ||
    typeof value.mimeType !== "string" ||
    !allowedMimeTypes.has(value.mimeType) ||
    typeof value.size !== "number"
  ) {
    return null;
  }
  return {
    idempotencyKey: value.idempotencyKey,
    cloudFileId: value.cloudFileId,
    fileName: value.fileName,
    mimeType: value.mimeType as SupportedImageMimeType,
    size: value.size,
  };
}

function parseOptionalImageReference(
  value: Record<string, unknown>,
): WechatCloudSourceImageReference | null | undefined {
  const hasImageField = ["cloudFileId", "fileName", "mimeType", "size"].some(
    (key) => value[key] !== undefined,
  );
  return hasImageField ? parseImageReference(value) : undefined;
}

function parseRequest(value: unknown): WechatCloudBusinessRequest | null {
  if (!isRecord(value) || typeof value.action !== "string") {
    return null;
  }
  if (value.action === "get-generation-job" && typeof value.jobId === "string") {
    return { action: value.action, jobId: value.jobId };
  }
  if (
    value.action === "create-refinement" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.parentJobId === "string" &&
    typeof value.instruction === "string"
  ) {
    const image = parseOptionalImageReference(value);
    if (image === null) {
      return null;
    }
    return {
      action: value.action,
      idempotencyKey: value.idempotencyKey,
      parentJobId: value.parentJobId,
      instruction: value.instruction,
      ...(image ?? {}),
    };
  }
  const image = parseImageReference(value);
  if (!image) {
    return null;
  }
  if (value.action === "analyze-garment") {
    const brief = parseBrief(value.brief);
    return brief ? { action: value.action, ...image, brief } : null;
  }
  if (value.action === "create-generation") {
    const brief = parseBrief(value.brief);
    if (
      !brief ||
      (value.analysisId !== undefined && typeof value.analysisId !== "string") ||
      (value.directionId !== undefined && typeof value.directionId !== "string") ||
      (value.parentJobId !== undefined && typeof value.parentJobId !== "string")
    ) {
      return null;
    }
    return {
      action: value.action,
      ...image,
      brief,
      ...(typeof value.analysisId === "string" ? { analysisId: value.analysisId } : {}),
      ...(typeof value.directionId === "string" ? { directionId: value.directionId } : {}),
      ...(typeof value.parentJobId === "string" ? { parentJobId: value.parentJobId } : {}),
    };
  }
  return null;
}

function refinementSourceImageReference(
  input: CreateWechatCloudRefinementRequest,
): WechatCloudSourceImageReference | null {
  if (
    input.cloudFileId === undefined ||
    input.fileName === undefined ||
    input.mimeType === undefined ||
    input.size === undefined
  ) {
    return null;
  }
  return {
    idempotencyKey: input.idempotencyKey,
    cloudFileId: input.cloudFileId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: input.size,
  };
}

function validateIdempotencyKey(idempotencyKey: string): string | null {
  return /^[A-Za-z0-9._-]{8,128}$/.test(idempotencyKey) ? null : "幂等键格式不正确。";
}

function validateImageReference(
  input: WechatCloudSourceImageReference,
  ownerId: string,
): string | null {
  const idempotencyMessage = validateIdempotencyKey(input.idempotencyKey);
  if (idempotencyMessage) {
    return idempotencyMessage;
  }
  if (!input.cloudFileId.startsWith("cloud://") || input.cloudFileId.length > 1_024) {
    return "云文件引用格式不正确。";
  }
  const extensionByMimeType: Record<SupportedImageMimeType, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const expectedPath = `/garment-source-temp/${ownerId}/incoming/${input.idempotencyKey}.${extensionByMimeType[input.mimeType]}`;
  if (!input.cloudFileId.endsWith(expectedPath)) {
    return "云文件路径与当前用户不匹配。";
  }
  if (!input.fileName.trim() || input.fileName.length > 200) {
    return "文件名格式不正确。";
  }
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > MAX_IMAGE_BYTES) {
    return "图片大小不符合要求。";
  }
  return null;
}

function fakeFact() {
  return {
    value: null,
    evidenceLevel: "unknown" as const,
    confidence: 0,
    evidence: "Fake Provider 只验证链路，不解析图片视觉内容。",
  };
}

function fakeDirection(
  id: "direction-1" | "direction-2" | "direction-3",
  name: string,
  summary: string,
  brief: GarmentAnalysisBrief,
  risk: "low" | "medium" | "high",
): GarmentAnalysis["designDirections"][number] {
  return {
    id,
    name,
    summary,
    changes: [
      {
        area: "silhouette",
        instruction: `围绕“${brief.changeRequest.trim()}”调整整体廓形与比例。`,
        reason: "用于验证设计方向选择和确定性生图请求是否贯通。",
      },
      {
        area: "craftsmanship",
        instruction: `以“${brief.styleDirection.trim()}”统一结构线与工艺语言。`,
        reason: "确保改款说明具备可追踪的输入来源。",
      },
    ],
    preserve: [...brief.preserveItems],
    productionRisk: {
      level: risk,
      newPatternPieces: [],
      newTrims: [],
      newOperations: [],
      fitOrStructureRisks: ["Fake Provider 未进行真实版型与工艺判断"],
      reason: "这是链路验证数据，不能用于打样或生产决策。",
    },
    promptRequirements: {
      positive: [brief.styleDirection.trim(), brief.changeRequest.trim()],
      hardConstraints:
        brief.preserveItems.length > 0 ? [...brief.preserveItems] : ["保持服装主体完整"],
      negative: ["新增文字", "额外水印", "品牌标志"],
    },
  };
}

function createFakeAnalysis(brief: GarmentAnalysisBrief): GarmentAnalysis {
  return garmentAnalysisSchema.parse({
    schemaVersion: "garment-dna-v0.2",
    visualFacts: {
      category: fakeFact(),
      silhouette: fakeFact(),
      length: fakeFact(),
      shoulder: fakeFact(),
      collar: fakeFact(),
      closure: fakeFact(),
      sleeve: fakeFact(),
      cuff: fakeFact(),
      pockets: fakeFact(),
      frontPanels: fakeFact(),
      backPanels: fakeFact(),
      fabric: fakeFact(),
      color: fakeFact(),
      trims: fakeFact(),
      craftsmanship: fakeFact(),
      presentation: fakeFact(),
    },
    userConstraints: {
      preserve: [...brief.preserveItems],
      modify: [brief.changeRequest.trim()],
      avoid: ["新增文字、水印或品牌标志"],
    },
    conflictsOrQuestions: ["当前为 Fake Provider 链路验证结果，未调用视觉模型。"],
    designDirections: [
      fakeDirection(
        "direction-1",
        "商业平衡方向",
        "在保留原款识别度的同时验证主要改款目标。",
        brief,
        "low",
      ),
      fakeDirection(
        "direction-2",
        "结构探索方向",
        "放大廓形与结构线变化，用于验证不同方向可独立选择。",
        brief,
        "medium",
      ),
      fakeDirection(
        "direction-3",
        "工艺强化方向",
        "围绕细节与工艺语言形成第三个可选方案。",
        brief,
        "high",
      ),
    ],
    recommendedDirectionId: "direction-1",
    recommendationReason: "Fake Provider 默认推荐第一方向，仅用于验证用户选择流程。",
  });
}

function requestFingerprint(request: WechatCloudBusinessRequest): string {
  return hash(JSON.stringify(request));
}

function quotaReservations(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  ownerId: string,
  kind: "analysis" | "generation",
  now: string,
) {
  const userLimit =
    kind === "analysis"
      ? dependencies.trialDailyAnalysisLimit
      : dependencies.trialDailyGenerationLimit;
  const globalLimit =
    kind === "analysis"
      ? dependencies.globalDailyAnalysisLimit
      : dependencies.globalDailyGenerationLimit;
  return [
    {
      scope: "user" as const,
      subjectId: ownerId,
      kind,
      day: dayOf(now),
      amount: 1,
      limit: userLimit,
    },
    {
      scope: "global" as const,
      subjectId: "controlled-trial",
      kind,
      day: dayOf(now),
      amount: 1,
      limit: globalLimit,
    },
  ];
}

async function analyze(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  ownerId: string,
  request: CreateWechatCloudGarmentAnalysisRequest,
  now: string,
): Promise<GarmentAnalysisApiResponse> {
  const fingerprint = requestFingerprint(request);
  const existingIdempotency = await dependencies.persistence.idempotency.find(
    ownerId,
    "analysis",
    request.idempotencyKey,
    now,
  );
  if (existingIdempotency) {
    if (existingIdempotency.requestFingerprint !== fingerprint) {
      throw new IdempotencyConflictError();
    }
    const existing = await dependencies.persistence.analyses.findById(
      ownerId,
      existingIdempotency.resourceId,
      now,
    );
    if (!existing) {
      throw new AnalysisExecutionStateError(
        Date.parse(now) - Date.parse(existingIdempotency.createdAt) < 180_000
          ? "ANALYSIS_EXECUTION_IN_PROGRESS"
          : "ANALYSIS_EXECUTION_INTERRUPTED",
      );
    }
    return existing.response;
  }
  const providerMode = dependencies.providerMode;
  if (providerMode === "disabled") {
    throw new ProviderConfigurationChangedError();
  }
  const bytes = await dependencies.storage.read(request.cloudFileId);
  if (bytes.byteLength !== request.size) {
    throw new Error("uploaded image size mismatch");
  }
  const imageSha256 = hashBytes(bytes);
  const expiresAt = addHours(now, dependencies.assetRetentionHours);
  const proposedAnalysisId = (dependencies.createResourceId ?? randomUUID)();

  const admission = await dependencies.persistence.transactions.run(async () => {
    const existingIdempotency = await dependencies.persistence.idempotency.find(
      ownerId,
      "analysis",
      request.idempotencyKey,
      now,
    );
    if (existingIdempotency) {
      if (existingIdempotency.requestFingerprint !== fingerprint) {
        throw new IdempotencyConflictError();
      }
      const existing = await dependencies.persistence.analyses.findById(
        ownerId,
        existingIdempotency.resourceId,
        now,
      );
      if (!existing) {
        throw new AnalysisExecutionStateError(
          Date.parse(now) - Date.parse(existingIdempotency.createdAt) < 180_000
            ? "ANALYSIS_EXECUTION_IN_PROGRESS"
            : "ANALYSIS_EXECUTION_INTERRUPTED",
        );
      }
      return { reused: true as const, response: existing.response };
    }

    const quota = await dependencies.persistence.quotas.reserveMany(
      quotaReservations(dependencies, ownerId, "analysis", now),
    );
    if (!quota.allowed) {
      throw new TrialQuotaExceededError(quota.denied);
    }

    await dependencies.persistence.assets.save({
      assetId: `analysis-source-${proposedAnalysisId}`,
      ownerId,
      kind: "source",
      fileId: request.cloudFileId,
      mimeType: request.mimeType,
      size: request.size,
      createdAt: now,
      expiresAt,
    });
    if (
      !(await dependencies.persistence.idempotency.create({
        ownerId,
        action: "analysis",
        key: request.idempotencyKey,
        requestFingerprint: fingerprint,
        resourceId: proposedAnalysisId,
        createdAt: now,
        expiresAt,
      }))
    ) {
      throw new ApplicationStateConflictError("分析幂等记录已经存在。");
    }
    return { reused: false as const, response: null };
  });

  if (admission.reused) {
    return admission.response;
  }

  const providerResult = await runAnalysisProvider(dependencies, request, bytes);
  const evidence = applyEvidenceGate(providerResult.analysis.visualFacts);
  const response: GarmentAnalysisApiResponse = {
    analysisId: proposedAnalysisId,
    status: "succeeded",
    provider: providerResult.provider,
    model: providerResult.model,
    durationMs: providerResult.durationMs,
    analysis: providerResult.analysis,
    evidenceSummary: {
      accepted: evidence.accepted.length,
      needsReview: evidence.needsReview.length,
      unknown: evidence.unknown.length,
    },
  };
  await dependencies.persistence.analyses.save({
    analysisId: proposedAnalysisId,
    ownerId,
    response,
    sourceImageSha256: imageSha256,
    expiresAt,
  });
  dependencies.logEvent?.({
    event: "garment-analysis-completed",
    analysisId: proposedAnalysisId,
    provider: providerResult.provider,
    model: providerResult.model,
    providerRequestId: providerResult.providerRequestId,
    durationMs: providerResult.durationMs,
    attemptCount: providerResult.attemptCount,
    usage: providerResult.usage,
  });
  return response;
}

class AnalysisExecutionStateError extends Error {
  constructor(readonly code: "ANALYSIS_EXECUTION_IN_PROGRESS" | "ANALYSIS_EXECUTION_INTERRUPTED") {
    super(code);
    this.name = "AnalysisExecutionStateError";
  }
}

async function runAnalysisProvider(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  request: CreateWechatCloudGarmentAnalysisRequest,
  bytes: Uint8Array,
): Promise<GarmentAnalysisProviderResult> {
  if (dependencies.providerMode === "fake") {
    return {
      provider: "testing-fake",
      model: "fake-garment-analysis-v1",
      providerRequestId: null,
      durationMs: 0,
      attemptCount: 1,
      usage: {
        generatedImages: 0,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        size: null,
      },
      analysis: createFakeAnalysis(request.brief),
    };
  }
  if (dependencies.providerMode !== "alibaba-qwen" || !dependencies.analysisProvider?.configured) {
    throw new ProviderConfigurationChangedError();
  }
  return dependencies.analysisProvider.analyze({
    sourceImage: {
      bytes,
      fileName: request.fileName,
      mimeType: request.mimeType,
    },
    brief: request.brief,
    schemaVersion: "garment-dna-v0.2",
  });
}

type ExecutableProviderMode = Exclude<GarmentCloudBusinessProviderMode, "disabled">;

interface GarmentGenerationContext {
  readonly strategy: "direct" | "analyzed";
  readonly directionId: string | null;
  readonly directionName: string | null;
  readonly summary: string;
  readonly operation: "initial" | "regenerate" | "refine";
  readonly parentJobId: string | null;
  readonly revisionInstruction: string | null;
  readonly prompt: string;
  readonly promptVersion: GenerationPromptVersion;
  readonly basePrompt: string;
  readonly baseSummary: string;
  readonly baseRequestFingerprint: string;
  readonly sourceImageSha256: string;
  readonly revisionInstructions: readonly string[];
}

interface GarmentGenerationExecutionPayload {
  readonly version: "garment-generation-v2";
  readonly providerMode: ExecutableProviderMode;
  readonly source: WechatCloudSourceImageReference;
  readonly context: GarmentGenerationContext;
}

class InvalidGenerationExecutionPayloadError extends Error {}
class ProviderConfigurationChangedError extends Error {}
class ParentAssetExpiredError extends Error {}

async function resolveGenerationSource(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  ownerId: string,
  request: CreateWechatCloudGenerationRequest | CreateWechatCloudRefinementRequest,
  now: string,
): Promise<WechatCloudSourceImageReference> {
  if (request.action === "create-generation") {
    return request;
  }
  const uploadedSource = refinementSourceImageReference(request);
  if (uploadedSource) {
    return uploadedSource;
  }
  const parent = await dependencies.persistence.tasks.findById(ownerId, request.parentJobId, now);
  if (!parent || parent.status.status !== "succeeded") {
    throw new RangeError("没有找到可以继续修改的上一版结果。");
  }
  const parentPayload = parseGenerationExecutionPayload(parent.executionPayload);
  if (!parentPayload || parentPayload.providerMode !== dependencies.providerMode) {
    throw new RangeError("上一版结果无法复用原图，请重新上传原图后再继续修改。");
  }
  return parentPayload.source;
}

async function resolveGenerationContext(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  ownerId: string,
  request: CreateWechatCloudGenerationRequest | CreateWechatCloudRefinementRequest,
  source: WechatCloudSourceImageReference,
  now: string,
  bytes: Uint8Array,
): Promise<GarmentGenerationContext> {
  const sourceImage: SourceImageInput = {
    bytes,
    fileName: source.fileName,
    mimeType: source.mimeType,
  };
  const sourceImageSha256 = hashBytes(bytes);
  if (request.action === "create-refinement") {
    if (request.instruction.trim().length < 2 || request.instruction.length > 500) {
      throw new RangeError("修改要求格式不正确。");
    }
    const parent = await dependencies.persistence.tasks.findById(ownerId, request.parentJobId, now);
    if (!parent || parent.status.status !== "succeeded") {
      throw new RangeError("没有找到可以继续修改的上一版结果。");
    }
    const parentPayload = parseGenerationExecutionPayload(parent.executionPayload);
    if (!parentPayload || parentPayload.providerMode !== dependencies.providerMode) {
      throw new RangeError("上一版结果来自其他 Provider，请从当前原图重新生成后再继续修改。");
    }
    if (parentPayload.context.sourceImageSha256 !== sourceImageSha256) {
      throw new RangeError("当前原图与生成分支不一致，无法继续修改。");
    }
    if (
      parentPayload.context.revisionInstructions.length >= (dependencies.maxRefinementDepth ?? 3)
    ) {
      throw new RangeError("当前分支已达到继续修改次数上限，请从原图重新生成。");
    }
    const revisionInstructions = [
      ...parentPayload.context.revisionInstructions,
      request.instruction.trim(),
    ];
    return {
      strategy: parent.status.strategy,
      directionId: parent.status.directionId,
      directionName: parent.status.directionName,
      summary: `${parentPayload.context.baseSummary} · 继续修改：${request.instruction.trim()}`,
      operation: "refine" as const,
      parentJobId: parent.jobId,
      revisionInstruction: request.instruction.trim(),
      prompt: compileGarmentIterationPrompt({
        basePrompt: parentPayload.context.basePrompt,
        revisionInstructions,
        usesOriginalSourceImage: true,
      }),
      promptVersion: "garment-iteration-v1",
      basePrompt: parentPayload.context.basePrompt,
      baseSummary: parentPayload.context.baseSummary,
      baseRequestFingerprint: parentPayload.context.baseRequestFingerprint,
      sourceImageSha256,
      revisionInstructions,
    };
  }

  if ((request.analysisId === undefined) !== (request.directionId === undefined)) {
    throw new RangeError("分析结果和设计方向必须同时提供。");
  }
  const analyzed = Boolean(request.analysisId && request.directionId);
  const generationInput: GarmentGenerationInput = {
    ...request.brief,
    sourceImage,
    outputCount: 1,
    promptVersion: analyzed ? "garment-analysis-v1" : "garment-redesign-v1",
  };
  let prompt = buildGarmentPrompt(generationInput);
  let directionName: string | null = null;
  if (request.analysisId && request.directionId) {
    const analysis = await dependencies.persistence.analyses.findById(
      ownerId,
      request.analysisId,
      now,
    );
    const direction = analysis
      ? findDesignDirection(analysis.response.analysis, request.directionId)
      : null;
    if (!analysis || !direction) {
      throw new RangeError("分析结果或设计方向不存在或已经过期。");
    }
    const legacySourceImageSha256 = hash(Buffer.from(bytes).toString("base64"));
    if (
      analysis.sourceImageSha256 !== sourceImageSha256 &&
      analysis.sourceImageSha256 !== legacySourceImageSha256
    ) {
      throw new RangeError("当前图片与服装分析不一致，请重新分析。");
    }
    directionName = direction.name;
    prompt = compileAnalyzedGarmentPrompt({
      request: generationInput,
      analysis: analysis.response.analysis,
      direction,
    });
  }
  const baseSummary = createGenerationSummary(generationInput);
  const summary = `${directionName ? `${baseSummary} · ${directionName}` : baseSummary}${
    dependencies.providerMode === "fake" ? " · Fake Provider 链路验证" : ""
  }`;
  const baseRequestFingerprint = hash(
    JSON.stringify({
      sourceImageSha256,
      brief: request.brief,
      analysisId: request.analysisId ?? null,
      directionId: request.directionId ?? null,
    }),
  );
  if (request.parentJobId) {
    const parent = await dependencies.persistence.tasks.findById(ownerId, request.parentJobId, now);
    if (!parent || parent.status.status !== "succeeded") {
      throw new RangeError("没有找到用于再次生成的上一版结果。");
    }
    const parentPayload = parseGenerationExecutionPayload(parent.executionPayload);
    if (
      !parentPayload ||
      parentPayload.providerMode !== dependencies.providerMode ||
      parentPayload.context.baseRequestFingerprint !== baseRequestFingerprint
    ) {
      throw new RangeError("上一张结果与当前原图、设计方向或 Provider 不一致。");
    }
  }
  return {
    strategy: analyzed ? ("analyzed" as const) : ("direct" as const),
    directionId: request.directionId ?? null,
    directionName,
    summary,
    operation: request.parentJobId ? ("regenerate" as const) : ("initial" as const),
    parentJobId: request.parentJobId ?? null,
    revisionInstruction: null,
    prompt,
    promptVersion: generationInput.promptVersion,
    basePrompt: prompt,
    baseSummary: summary,
    baseRequestFingerprint,
    sourceImageSha256,
    revisionInstructions: [],
  };
}

function parseNullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function parseGenerationExecutionPayload(value: unknown): GarmentGenerationExecutionPayload | null {
  if (
    !isRecord(value) ||
    value.version !== "garment-generation-v2" ||
    (value.providerMode !== "fake" && value.providerMode !== "alibaba-qwen") ||
    !isRecord(value.source) ||
    !isRecord(value.context)
  ) {
    return null;
  }
  const source = parseImageReference(value.source);
  const directionId = parseNullableString(value.context.directionId);
  const directionName = parseNullableString(value.context.directionName);
  const parentJobId = parseNullableString(value.context.parentJobId);
  const revisionInstruction = parseNullableString(value.context.revisionInstruction);
  const promptVersions = new Set<string>([
    "garment-redesign-v1",
    "garment-analysis-v1",
    "garment-iteration-v1",
  ]);
  if (
    !source ||
    (value.context.strategy !== "direct" && value.context.strategy !== "analyzed") ||
    directionId === undefined ||
    directionName === undefined ||
    typeof value.context.summary !== "string" ||
    value.context.summary.length > 2_000 ||
    (value.context.operation !== "initial" &&
      value.context.operation !== "regenerate" &&
      value.context.operation !== "refine") ||
    parentJobId === undefined ||
    revisionInstruction === undefined ||
    typeof value.context.prompt !== "string" ||
    value.context.prompt.length < 1 ||
    value.context.prompt.length > 40_000 ||
    typeof value.context.promptVersion !== "string" ||
    !promptVersions.has(value.context.promptVersion) ||
    typeof value.context.basePrompt !== "string" ||
    value.context.basePrompt.length < 1 ||
    value.context.basePrompt.length > 40_000 ||
    typeof value.context.baseSummary !== "string" ||
    value.context.baseSummary.length < 1 ||
    value.context.baseSummary.length > 2_000 ||
    typeof value.context.baseRequestFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.context.baseRequestFingerprint) ||
    typeof value.context.sourceImageSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.context.sourceImageSha256) ||
    !Array.isArray(value.context.revisionInstructions) ||
    value.context.revisionInstructions.length > 12 ||
    !value.context.revisionInstructions.every(
      (instruction) =>
        typeof instruction === "string" &&
        instruction.trim().length >= 2 &&
        instruction.length <= 500,
    )
  ) {
    return null;
  }
  return {
    version: value.version,
    providerMode: value.providerMode,
    source,
    context: {
      strategy: value.context.strategy,
      directionId,
      directionName,
      summary: value.context.summary,
      operation: value.context.operation,
      parentJobId,
      revisionInstruction,
      prompt: value.context.prompt,
      promptVersion: value.context.promptVersion as GenerationPromptVersion,
      basePrompt: value.context.basePrompt,
      baseSummary: value.context.baseSummary,
      baseRequestFingerprint: value.context.baseRequestFingerprint,
      sourceImageSha256: value.context.sourceImageSha256,
      revisionInstructions: value.context.revisionInstructions as string[],
    },
  };
}

function generationExecutionPayload(
  providerMode: ExecutableProviderMode,
  source: WechatCloudSourceImageReference,
  context: GarmentGenerationContext,
): GarmentGenerationExecutionPayload {
  return {
    version: "garment-generation-v2",
    providerMode,
    source,
    context,
  };
}

async function completeFailedGeneration(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  ownerId: string,
  task: GenerationTaskRecord,
  leaseId: string,
  error: unknown,
): Promise<GenerationJobStatusResponse> {
  const completedAt = dependencies.now();
  const normalized = normalizeGenerationFailure(dependencies, error);
  const failed: GenerationJobFailedResponse = {
    jobId: task.jobId,
    status: "failed",
    error: normalized,
    createdAt: task.createdAt,
    updatedAt: completedAt,
  };
  dependencies.logEvent?.({
    event: "garment-generation-failed",
    jobId: task.jobId,
    code: normalized.code,
    retryable: normalized.retryable,
  });
  const execution = new GenerationTaskExecutionService(dependencies.persistence);
  try {
    return (
      await execution.complete({
        ownerId,
        jobId: task.jobId,
        leaseId,
        now: completedAt,
        status: failed,
      })
    ).status;
  } catch {
    return (
      (await dependencies.persistence.tasks.findById(ownerId, task.jobId, completedAt))?.status ??
      failed
    );
  }
}

function normalizeGenerationFailure(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  error: unknown,
): ApiErrorResponse {
  if (error instanceof InvalidGenerationExecutionPayloadError) {
    return {
      code: "GENERATION_EXECUTION_PAYLOAD_INVALID",
      message: "生成任务执行数据无效，请重新提交。",
      requestId: (dependencies.createRequestId ?? randomUUID)(),
      retryable: false,
    };
  }
  if (error instanceof ProviderConfigurationChangedError) {
    return {
      code: "CLOUD_BACKEND_NOT_DEPLOYED",
      message: "任务创建后云端 Provider 配置发生变化，已停止执行以避免错误计费。",
      requestId: (dependencies.createRequestId ?? randomUUID)(),
      retryable: false,
    };
  }
  if (error instanceof GarmentProviderError) {
    return {
      code: error.code,
      message: error.message,
      requestId: error.requestId ?? (dependencies.createRequestId ?? randomUUID)(),
      retryable: error.retryable,
    };
  }
  return {
    code:
      dependencies.providerMode === "fake"
        ? "FAKE_PROVIDER_EXECUTION_FAILED"
        : "GENERATION_PROVIDER_EXECUTION_FAILED",
    message:
      dependencies.providerMode === "fake"
        ? "测试生图任务执行失败，请稍后重试。"
        : "生图任务执行失败，系统没有自动重复调用模型。",
    requestId: (dependencies.createRequestId ?? randomUUID)(),
    retryable: true,
  };
}

async function runImageProvider(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  payload: GarmentGenerationExecutionPayload,
  bytes: Uint8Array,
): Promise<GarmentGenerationResult> {
  if (payload.providerMode !== dependencies.providerMode) {
    throw new ProviderConfigurationChangedError();
  }
  if (payload.providerMode === "fake") {
    const delayMs = dependencies.fakeGenerationDelayMs ?? 0;
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    return {
      provider: "testing-fake",
      model: "fake-image-copy-v1",
      providerRequestId: null,
      durationMs: delayMs,
      assets: [{ bytes, mimeType: payload.source.mimeType }],
      usage: {
        generatedImages: 1,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        size: null,
      },
    };
  }
  if (!dependencies.imageProvider?.configured) {
    throw new ProviderConfigurationChangedError();
  }
  return dependencies.imageProvider.generateVariation({
    sourceImage: {
      bytes,
      fileName: payload.source.fileName,
      mimeType: payload.source.mimeType,
    },
    prompt: payload.context.prompt,
    outputCount: 1,
    promptVersion: payload.context.promptVersion,
  });
}

async function executeGenerationTask(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  ownerId: string,
  jobId: string,
  now: string,
): Promise<GenerationJobStatusResponse> {
  const leaseId = (dependencies.createResourceId ?? randomUUID)();
  const execution = new GenerationTaskExecutionService(dependencies.persistence);
  const claim = await execution.claim({
    ownerId,
    jobId,
    leaseId,
    now,
    leaseExpiresAt: addSeconds(now, dependencies.executionLeaseSeconds ?? 60),
    interruptedError: interruptedExecutionError(dependencies),
  });
  if (!claim.claimed) {
    return claim.task.status;
  }

  try {
    const payload = parseGenerationExecutionPayload(claim.task.executionPayload);
    if (!payload || validateImageReference(payload.source, ownerId)) {
      throw new InvalidGenerationExecutionPayloadError();
    }
    const bytes = await dependencies.storage.read(payload.source.cloudFileId);
    if (bytes.byteLength !== payload.source.size) {
      throw new Error("uploaded image size mismatch");
    }
    if (hashBytes(bytes) !== payload.context.sourceImageSha256) {
      throw new InvalidGenerationExecutionPayloadError();
    }
    await dependencies.persistence.assets.save({
      assetId: `source-${jobId}`,
      ownerId,
      kind: "source",
      fileId: payload.source.cloudFileId,
      mimeType: payload.source.mimeType,
      size: payload.source.size,
      createdAt: now,
      expiresAt: claim.task.expiresAt,
    });
    await execution.markProviderCallStarted({
      ownerId,
      jobId,
      leaseId,
      now: dependencies.now(),
    });
    const providerResult = await runImageProvider(dependencies, payload, bytes);
    const firstAsset = providerResult.assets[0];
    if (!firstAsset) {
      throw new GarmentProviderError("PROVIDER_BAD_RESPONSE", "生图结果中没有图片。");
    }
    const savedResult = await dependencies.storage.save({
      ownerId,
      assetId: `result-${jobId}`,
      kind: "result",
      mimeType: firstAsset.mimeType,
      bytes: firstAsset.bytes,
    });
    const completedAt = dependencies.now();
    await dependencies.persistence.assets.save({
      assetId: `result-${jobId}`,
      ownerId,
      kind: "result",
      fileId: savedResult.fileId,
      mimeType: firstAsset.mimeType,
      size: savedResult.size,
      createdAt: completedAt,
      expiresAt: claim.task.expiresAt,
    });
    const succeeded: GenerationApiResponse = {
      jobId,
      status: "succeeded",
      provider: providerResult.provider,
      model: providerResult.model,
      resultUrl: savedResult.fileId,
      summary: payload.context.summary,
      durationMs: providerResult.durationMs,
      strategy: payload.context.strategy,
      directionId: payload.context.directionId,
      directionName: payload.context.directionName,
      operation: payload.context.operation,
      parentJobId: payload.context.parentJobId,
      revisionInstruction: payload.context.revisionInstruction,
      createdAt: claim.task.createdAt,
    };
    dependencies.logEvent?.({
      event: "garment-generation-completed",
      jobId,
      provider: providerResult.provider,
      model: providerResult.model,
      providerRequestId: providerResult.providerRequestId,
      durationMs: providerResult.durationMs,
      usage: providerResult.usage,
      promptVersion: payload.context.promptVersion,
      operation: payload.context.operation,
    });
    return (
      await execution.complete({
        ownerId,
        jobId,
        leaseId,
        now: completedAt,
        status: succeeded,
      })
    ).status;
  } catch (error) {
    return completeFailedGeneration(dependencies, ownerId, claim.task, leaseId, error);
  }
}

async function createGeneration(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  ownerId: string,
  request: CreateWechatCloudGenerationRequest | CreateWechatCloudRefinementRequest,
  now: string,
): Promise<GenerationJobStatusResponse> {
  const action = request.action === "create-refinement" ? "refinement" : "generation";
  const fingerprint = requestFingerprint(request);
  const existingIdempotency = await dependencies.persistence.idempotency.find(
    ownerId,
    action,
    request.idempotencyKey,
    now,
  );
  if (existingIdempotency) {
    if (existingIdempotency.requestFingerprint !== fingerprint) {
      throw new IdempotencyConflictError();
    }
    const existingTask = await dependencies.persistence.tasks.findById(
      ownerId,
      existingIdempotency.resourceId,
      now,
    );
    if (!existingTask) {
      throw new ApplicationStateConflictError("幂等记录绑定的生成任务不存在或已经过期。");
    }
    return existingTask.status;
  }

  const providerMode = dependencies.providerMode;
  if (providerMode === "disabled") {
    throw new ProviderConfigurationChangedError();
  }
  const source = await resolveGenerationSource(dependencies, ownerId, request, now);
  const sourceValidationMessage = validateImageReference(source, ownerId);
  if (sourceValidationMessage) {
    throw new RangeError(sourceValidationMessage);
  }
  let bytes: Uint8Array;
  try {
    bytes = await dependencies.storage.read(source.cloudFileId);
  } catch (error) {
    if (request.action === "create-refinement" && !refinementSourceImageReference(request)) {
      throw new ParentAssetExpiredError();
    }
    throw error;
  }
  if (bytes.byteLength !== source.size) {
    throw new Error("uploaded image size mismatch");
  }
  const context = await resolveGenerationContext(
    dependencies,
    ownerId,
    request,
    source,
    now,
    bytes,
  );
  const proposedJobId = (dependencies.createResourceId ?? randomUUID)();
  const expiresAt = addHours(now, dependencies.assetRetentionHours);
  const admission = await new GenerationTaskAdmissionService(dependencies.persistence).admit({
    ownerId,
    action,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: fingerprint,
    executionPayload: generationExecutionPayload(providerMode, source, context),
    jobId: proposedJobId,
    statusUrl: `wechat-cloud://generation-jobs/${proposedJobId}`,
    createdAt: now,
    expiresAt,
    quotaReservations: quotaReservations(dependencies, ownerId, "generation", now),
    sourceAsset: {
      assetId: `source-${proposedJobId}`,
      ownerId,
      kind: "source",
      fileId: source.cloudFileId,
      mimeType: source.mimeType,
      size: source.size,
      createdAt: now,
      expiresAt,
    },
  });
  return admission.task.status;
}

function mapKnownError(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  error: unknown,
): WechatCloudResponse | null {
  if (error instanceof TrialQuotaExceededError) {
    return apiError(dependencies, error.code, error.message, false);
  }
  if (error instanceof IdempotencyConflictError) {
    return apiError(dependencies, "IDEMPOTENCY_KEY_CONFLICT", error.message, false);
  }
  if (error instanceof ApplicationStateConflictError) {
    return apiError(dependencies, error.code, error.message, false);
  }
  if (error instanceof ProviderConfigurationChangedError) {
    return apiError(
      dependencies,
      "CLOUD_BACKEND_NOT_DEPLOYED",
      dependencies.providerConfigurationError ?? "微信云端业务 Provider 尚未启用。",
      false,
    );
  }
  if (error instanceof AnalysisExecutionStateError) {
    return apiError(
      dependencies,
      error.code,
      error.code === "ANALYSIS_EXECUTION_IN_PROGRESS"
        ? "同一分析请求仍在云端执行，请稍后重试。"
        : "分析执行可能在模型调用后中断，已停止自动重试以避免重复计费。",
      error.code === "ANALYSIS_EXECUTION_IN_PROGRESS",
    );
  }
  if (error instanceof ParentAssetExpiredError) {
    return apiError(
      dependencies,
      "PARENT_ASSET_EXPIRED",
      "继续修改所需的原图已经过期，请重新上传原图后再试。",
      false,
    );
  }
  if (error instanceof GarmentProviderError) {
    return apiError(dependencies, error.code, error.message, false);
  }
  if (error instanceof RangeError) {
    return apiError(dependencies, "VALIDATION_CLOUD_BUSINESS_INVALID", error.message, false);
  }
  return null;
}

export function isWechatCloudBusinessAction(event: unknown): boolean {
  return isRecord(event) && typeof event.action === "string" && businessActions.has(event.action);
}

export function createGarmentCloudBusinessHandler(
  dependencies: GarmentCloudBusinessHandlerDependencies,
) {
  return async (event: unknown): Promise<WechatCloudResponse> => {
    const openId = dependencies.getOpenId();
    if (!openId) {
      return apiError(
        dependencies,
        "AUTH_WECHAT_CONTEXT_MISSING",
        "无法识别当前微信用户，请重新进入小程序。",
        true,
      );
    }
    const request = parseRequest(event);
    if (!request) {
      return apiError(
        dependencies,
        "VALIDATION_CLOUD_REQUEST_INVALID",
        "云端业务请求格式不正确。",
        false,
      );
    }
    const ownerId = viewerFingerprint(openId);
    try {
      if (!(await dependencies.isTrialMember(ownerId))) {
        return apiError(
          dependencies,
          "AUTH_TRIAL_MEMBER_REQUIRED",
          "当前微信账号尚未加入体验名单。",
          false,
        );
      }
      const now = dependencies.now();
      if (request.action === "get-generation-job") {
        if (!/^[a-zA-Z0-9-]{8,128}$/.test(request.jobId)) {
          return apiError(
            dependencies,
            "VALIDATION_JOB_ID_INVALID",
            "生成任务编号格式不正确。",
            false,
          );
        }
        const existingTask = await dependencies.persistence.tasks.findById(
          ownerId,
          request.jobId,
          now,
        );
        const status = existingTask
          ? await executeGenerationTask(dependencies, ownerId, request.jobId, now)
          : null;
        return status
          ? { ok: true, data: status }
          : apiError(dependencies, "GENERATION_JOB_NOT_FOUND", "没有找到对应的生成任务。", false);
      }

      const refinementSource =
        request.action === "create-refinement" ? refinementSourceImageReference(request) : null;
      const validationMessage =
        request.action === "create-refinement"
          ? (validateIdempotencyKey(request.idempotencyKey) ??
            (refinementSource ? validateImageReference(refinementSource, ownerId) : null))
          : validateImageReference(request, ownerId);
      if (validationMessage) {
        return apiError(
          dependencies,
          "VALIDATION_CLOUD_BUSINESS_INVALID",
          validationMessage,
          false,
        );
      }
      const data =
        request.action === "analyze-garment"
          ? await analyze(dependencies, ownerId, request, now)
          : await createGeneration(dependencies, ownerId, request, now);
      return { ok: true, data };
    } catch (error) {
      return (
        mapKnownError(dependencies, error) ??
        apiError(
          dependencies,
          "CLOUD_BUSINESS_UNAVAILABLE",
          "微信云端业务服务暂时不可用，请稍后重试。",
          true,
        )
      );
    }
  };
}
