import { createHash, randomUUID } from "node:crypto";

import {
  ApplicationStateConflictError,
  GenerationTaskAdmissionService,
  IdempotencyConflictError,
  TrialQuotaExceededError,
  type GarmentAnalysisRepository,
  type GarmentAssetRepository,
  type GenerationTaskRepository,
  type IdempotencyRepository,
  type TrialQuotaRepository,
  type ApplicationTransactionRunner,
} from "@cloth-idea/application";
import {
  garmentAnalysisSchema,
  supportedImageMimeTypes,
  type ApiErrorResponse,
  type CreateWechatCloudGarmentAnalysisRequest,
  type CreateWechatCloudGenerationRequest,
  type CreateWechatCloudRefinementRequest,
  type GarmentAnalysis,
  type GarmentAnalysisApiResponse,
  type GarmentAnalysisBrief,
  type GenerationApiResponse,
  type GenerationJobFailedResponse,
  type GenerationJobStatusResponse,
  type SupportedImageMimeType,
  type WechatCloudBusinessRequest,
  type WechatCloudResponse,
  type WechatCloudSourceImageReference,
} from "@cloth-idea/domain";

import type { WechatCloudGarmentAssetStorage } from "./cloud-asset-storage";

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
  readonly fakeProviderEnabled: boolean;
  readonly now: () => string;
  readonly createResourceId?: () => string;
  readonly createRequestId?: () => string;
  readonly trialDailyAnalysisLimit: number;
  readonly trialDailyGenerationLimit: number;
  readonly globalDailyAnalysisLimit: number;
  readonly globalDailyGenerationLimit: number;
  readonly assetRetentionHours: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(value: string, length = 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function viewerFingerprint(openId: string): string {
  return hash(openId, 16);
}

function addHours(value: string, hours: number): string {
  return new Date(Date.parse(value) + hours * 60 * 60 * 1_000).toISOString();
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

function parseRequest(value: unknown): WechatCloudBusinessRequest | null {
  if (!isRecord(value) || typeof value.action !== "string") {
    return null;
  }
  if (value.action === "get-generation-job" && typeof value.jobId === "string") {
    return { action: value.action, jobId: value.jobId };
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
  if (
    value.action === "create-refinement" &&
    typeof value.parentJobId === "string" &&
    typeof value.instruction === "string"
  ) {
    return {
      action: value.action,
      ...image,
      parentJobId: value.parentJobId,
      instruction: value.instruction,
    };
  }
  return null;
}

function validateImageReference(
  input: WechatCloudSourceImageReference,
  ownerId: string,
): string | null {
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(input.idempotencyKey)) {
    return "幂等键格式不正确。";
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
      throw new ApplicationStateConflictError("幂等记录绑定的分析结果不存在或已经过期。");
    }
    return existing.response;
  }
  const bytes = await dependencies.storage.read(request.cloudFileId);
  if (bytes.byteLength !== request.size) {
    throw new Error("uploaded image size mismatch");
  }
  const imageSha256 = hash(Buffer.from(bytes).toString("base64"));
  const expiresAt = addHours(now, dependencies.assetRetentionHours);

  return dependencies.persistence.transactions.run(async () => {
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
        throw new ApplicationStateConflictError("幂等记录绑定的分析结果不存在或已经过期。");
      }
      return existing.response;
    }

    const quota = await dependencies.persistence.quotas.reserveMany(
      quotaReservations(dependencies, ownerId, "analysis", now),
    );
    if (!quota.allowed) {
      throw new TrialQuotaExceededError(quota.denied);
    }

    const analysisId = (dependencies.createResourceId ?? randomUUID)();
    const response: GarmentAnalysisApiResponse = {
      analysisId,
      status: "succeeded",
      provider: "testing-fake",
      model: "fake-garment-analysis-v1",
      durationMs: 0,
      analysis: createFakeAnalysis(request.brief),
      evidenceSummary: { accepted: 0, needsReview: 0, unknown: 16 },
    };
    await dependencies.persistence.assets.save({
      assetId: `analysis-source-${analysisId}`,
      ownerId,
      kind: "source",
      fileId: request.cloudFileId,
      mimeType: request.mimeType,
      size: request.size,
      createdAt: now,
      expiresAt,
    });
    await dependencies.persistence.analyses.save({
      analysisId,
      ownerId,
      response,
      sourceImageSha256: imageSha256,
      expiresAt,
    });
    if (
      !(await dependencies.persistence.idempotency.create({
        ownerId,
        action: "analysis",
        key: request.idempotencyKey,
        requestFingerprint: fingerprint,
        resourceId: analysisId,
        createdAt: now,
        expiresAt,
      }))
    ) {
      throw new ApplicationStateConflictError("分析幂等记录已经存在。");
    }
    return response;
  });
}

async function resolveGenerationContext(
  dependencies: GarmentCloudBusinessHandlerDependencies,
  ownerId: string,
  request: CreateWechatCloudGenerationRequest | CreateWechatCloudRefinementRequest,
  now: string,
) {
  if (request.action === "create-refinement") {
    if (request.instruction.trim().length < 2 || request.instruction.length > 500) {
      throw new RangeError("修改要求格式不正确。");
    }
    const parent = await dependencies.persistence.tasks.findById(ownerId, request.parentJobId, now);
    if (!parent || parent.status.status !== "succeeded") {
      throw new RangeError("没有找到可以继续修改的上一版结果。");
    }
    return {
      strategy: parent.status.strategy,
      directionId: parent.status.directionId,
      directionName: parent.status.directionName,
      summary: `${parent.status.summary} · 继续修改：${request.instruction.trim()}`,
      operation: "refine" as const,
      parentJobId: parent.jobId,
      revisionInstruction: request.instruction.trim(),
    };
  }

  if ((request.analysisId === undefined) !== (request.directionId === undefined)) {
    throw new RangeError("分析结果和设计方向必须同时提供。");
  }
  let directionName: string | null = null;
  if (request.analysisId && request.directionId) {
    const analysis = await dependencies.persistence.analyses.findById(
      ownerId,
      request.analysisId,
      now,
    );
    const direction = analysis?.response.analysis.designDirections.find(
      (candidate) => candidate.id === request.directionId,
    );
    if (!analysis || !direction) {
      throw new RangeError("分析结果或设计方向不存在或已经过期。");
    }
    directionName = direction.name;
  }
  if (request.parentJobId) {
    const parent = await dependencies.persistence.tasks.findById(ownerId, request.parentJobId, now);
    if (!parent || parent.status.status !== "succeeded") {
      throw new RangeError("没有找到用于再次生成的上一版结果。");
    }
  }
  return {
    strategy: request.analysisId ? ("analyzed" as const) : ("direct" as const),
    directionId: request.directionId ?? null,
    directionName,
    summary: `${request.brief.mode === "inspiration" ? "灵感设计" : "快速衍生"} · Fake Provider 链路验证 · ${request.brief.styleDirection.trim()}`,
    operation: request.parentJobId ? ("regenerate" as const) : ("initial" as const),
    parentJobId: request.parentJobId ?? null,
    revisionInstruction: null,
  };
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
    const existing = await dependencies.persistence.tasks.findById(
      ownerId,
      existingIdempotency.resourceId,
      now,
    );
    if (!existing) {
      throw new ApplicationStateConflictError("幂等记录绑定的生成任务不存在或已经过期。");
    }
    return existing.status;
  }

  const context = await resolveGenerationContext(dependencies, ownerId, request, now);
  const jobId = (dependencies.createResourceId ?? randomUUID)();
  const expiresAt = addHours(now, dependencies.assetRetentionHours);
  const admission = await new GenerationTaskAdmissionService(dependencies.persistence).admit({
    ownerId,
    action,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: fingerprint,
    jobId,
    statusUrl: `wechat-cloud://generation-jobs/${jobId}`,
    createdAt: now,
    expiresAt,
    quotaReservations: quotaReservations(dependencies, ownerId, "generation", now),
  });
  if (admission.reused) {
    return admission.task.status;
  }

  try {
    const bytes = await dependencies.storage.read(request.cloudFileId);
    if (bytes.byteLength !== request.size) {
      throw new Error("uploaded image size mismatch");
    }
    await dependencies.persistence.assets.save({
      assetId: `source-${jobId}`,
      ownerId,
      kind: "source",
      fileId: request.cloudFileId,
      mimeType: request.mimeType,
      size: request.size,
      createdAt: now,
      expiresAt,
    });
    const savedResult = await dependencies.storage.save({
      ownerId,
      assetId: `result-${jobId}`,
      kind: "result",
      mimeType: request.mimeType,
      bytes,
    });
    await dependencies.persistence.assets.save({
      assetId: `result-${jobId}`,
      ownerId,
      kind: "result",
      fileId: savedResult.fileId,
      mimeType: request.mimeType,
      size: savedResult.size,
      createdAt: now,
      expiresAt,
    });
    const succeeded: GenerationApiResponse = {
      jobId,
      status: "succeeded",
      provider: "testing-fake",
      model: "fake-image-copy-v1",
      resultUrl: savedResult.fileId,
      summary: context.summary,
      durationMs: 0,
      strategy: context.strategy,
      directionId: context.directionId,
      directionName: context.directionName,
      operation: context.operation,
      parentJobId: context.parentJobId,
      revisionInstruction: context.revisionInstruction,
      createdAt: now,
    };
    await dependencies.persistence.tasks.update({
      ...admission.task,
      status: succeeded,
      updatedAt: now,
    });
  } catch {
    const failed: GenerationJobFailedResponse = {
      jobId,
      status: "failed",
      error: {
        code: "FAKE_PROVIDER_EXECUTION_FAILED",
        message: "测试生图任务执行失败，请稍后重试。",
        requestId: (dependencies.createRequestId ?? randomUUID)(),
        retryable: true,
      },
      createdAt: now,
      updatedAt: now,
    };
    await dependencies.persistence.tasks.update({
      ...admission.task,
      status: failed,
      updatedAt: now,
    });
  }

  // 首次响应保持 queued，强制客户端验证任务状态查询和重启恢复路径。
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
      if (!dependencies.fakeProviderEnabled) {
        return apiError(
          dependencies,
          "CLOUD_BACKEND_NOT_DEPLOYED",
          "微信云端业务 Provider 尚未启用。",
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
        const task = await dependencies.persistence.tasks.findById(ownerId, request.jobId, now);
        return task
          ? { ok: true, data: task.status }
          : apiError(dependencies, "GENERATION_JOB_NOT_FOUND", "没有找到对应的生成任务。", false);
      }

      const validationMessage = validateImageReference(request, ownerId);
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
