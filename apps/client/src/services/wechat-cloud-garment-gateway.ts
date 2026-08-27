import {
  garmentAnalysisSchema,
  type GarmentAnalysisApiResponse,
  type GarmentAnalysisBrief,
  type GenerationApiResponse,
  type GenerationJobStatusResponse,
  type WechatCloudBusinessRequest,
  type WechatCloudCapabilities,
  type WechatCloudSourceImageReference,
} from "@cloth-idea/domain";
import Taro from "@tarojs/taro";

import {
  pendingGenerationJobStore,
  type PendingGenerationJobStore,
} from "../platform/pending-generation-platform";
import {
  GenerationApiError,
  type CreateGenerationRequest,
  type GarmentGateway,
  type RefineGenerationRequest,
  type TrialCapabilities,
} from "./garment-gateway";
import { callGarmentCloudFunction } from "./wechat-cloud-function-client";
import {
  createWechatCloudIdempotencyKey,
  getWechatCloudImageMetadata,
  type WechatCloudInfrastructureClient,
} from "./wechat-cloud-infrastructure";

const GENERATION_POLL_INTERVAL_MS = 1_000;
const GENERATION_POLL_BUDGET_MS = 360_000;

export type WechatCloudGarmentClient = WechatCloudInfrastructureClient;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function parseCapabilities(value: unknown): WechatCloudCapabilities {
  if (
    !isRecord(value) ||
    value.transport !== "wechat-cloud" ||
    typeof value.viewerFingerprint !== "string" ||
    typeof value.authorized !== "boolean" ||
    typeof value.trialDailyAnalysisLimit !== "number" ||
    typeof value.trialDailyGenerationLimit !== "number" ||
    typeof value.assetRetentionHours !== "number"
  ) {
    throw new GenerationApiError("云端能力信息无法识别。", "BAD_CLOUD_RESPONSE", true);
  }
  return value as unknown as WechatCloudCapabilities;
}

function parseAnalysis(value: unknown): GarmentAnalysisApiResponse {
  if (
    !isRecord(value) ||
    typeof value.analysisId !== "string" ||
    value.status !== "succeeded" ||
    (value.provider !== "alibaba-qwen-vl" && value.provider !== "testing-fake") ||
    typeof value.model !== "string" ||
    typeof value.durationMs !== "number" ||
    !isRecord(value.evidenceSummary)
  ) {
    throw new GenerationApiError("云端分析结果无法识别。", "BAD_CLOUD_RESPONSE", true);
  }
  const analysis = garmentAnalysisSchema.safeParse(value.analysis);
  const accepted = value.evidenceSummary.accepted;
  const needsReview = value.evidenceSummary.needsReview;
  const unknown = value.evidenceSummary.unknown;
  if (
    !analysis.success ||
    !Number.isInteger(accepted) ||
    !Number.isInteger(needsReview) ||
    !Number.isInteger(unknown) ||
    (accepted as number) + (needsReview as number) + (unknown as number) !== 16
  ) {
    throw new GenerationApiError("云端分析结果无法识别。", "BAD_CLOUD_RESPONSE", true);
  }
  return {
    analysisId: value.analysisId,
    status: value.status,
    provider: value.provider,
    model: value.model,
    durationMs: value.durationMs,
    analysis: analysis.data,
    evidenceSummary: {
      accepted: accepted as number,
      needsReview: needsReview as number,
      unknown: unknown as number,
    },
  };
}

function parseGenerationJob(value: unknown): GenerationJobStatusResponse {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    (value.status !== "queued" &&
      value.status !== "generating" &&
      value.status !== "succeeded" &&
      value.status !== "failed")
  ) {
    throw new GenerationApiError("云端任务状态无法识别。", "BAD_CLOUD_RESPONSE", true);
  }
  if (
    value.status === "succeeded" &&
    (typeof value.resultUrl !== "string" ||
      typeof value.summary !== "string" ||
      typeof value.model !== "string")
  ) {
    throw new GenerationApiError("云端任务结果无法识别。", "BAD_CLOUD_RESPONSE", true);
  }
  if (
    value.status === "failed" &&
    (!isRecord(value.error) ||
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string" ||
      typeof value.error.retryable !== "boolean")
  ) {
    throw new GenerationApiError("云端任务错误无法识别。", "BAD_CLOUD_RESPONSE", true);
  }
  return value as unknown as GenerationJobStatusResponse;
}

function createBrief(input: CreateGenerationRequest): GarmentAnalysisBrief {
  return {
    mode: input.mode,
    preserveItems: input.preserveItems
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 16),
    changeRequest: input.changeRequest,
    styleDirection: input.styleDirection,
    intensity: input.intensity,
  };
}

function imageSize(input: { readonly imageSize?: number }): number {
  if (!Number.isInteger(input.imageSize) || (input.imageSize ?? 0) <= 0) {
    throw new GenerationApiError(
      "微信云端请求缺少图片大小，请重新选择图片。",
      "VALIDATION_IMAGE_SIZE_REQUIRED",
      false,
    );
  }
  return input.imageSize as number;
}

function configuredClient(): WechatCloudGarmentClient {
  return Taro.cloud as unknown as WechatCloudGarmentClient;
}

export class WechatCloudGarmentGateway implements GarmentGateway {
  constructor(
    private readonly cloud: WechatCloudGarmentClient = configuredClient(),
    private readonly pendingJobs: PendingGenerationJobStore = pendingGenerationJobStore,
  ) {}

  private async callWithRetry(request: WechatCloudBusinessRequest): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await callGarmentCloudFunction(this.cloud, request);
      } catch (error) {
        if (!(error instanceof GenerationApiError) || !error.retryable || attempt === 1) {
          throw error;
        }
        await wait(300);
      }
    }
    throw new GenerationApiError("无法连接微信云端服务。", "CLOUD_FUNCTION_UNAVAILABLE", true);
  }

  private async capabilities(): Promise<WechatCloudCapabilities> {
    return parseCapabilities(
      await callGarmentCloudFunction(this.cloud, { action: "get-capabilities" }),
    );
  }

  private async uploadSource(
    imagePath: string,
    size: number,
  ): Promise<WechatCloudSourceImageReference> {
    const capabilities = await this.capabilities();
    if (!capabilities.authorized) {
      throw new GenerationApiError(
        "当前微信账号尚未加入体验名单。",
        "AUTH_TRIAL_MEMBER_REQUIRED",
        false,
      );
    }
    const idempotencyKey = createWechatCloudIdempotencyKey();
    const metadata = getWechatCloudImageMetadata(imagePath);
    let upload: { readonly fileID: string };
    try {
      upload = await this.cloud.uploadFile({
        cloudPath: `garment-source-temp/${capabilities.viewerFingerprint}/incoming/${idempotencyKey}.${metadata.extension}`,
        filePath: imagePath,
      });
    } catch {
      throw new GenerationApiError("原图上传到微信云端失败。", "CLOUD_UPLOAD_FAILED", true);
    }
    return {
      idempotencyKey,
      cloudFileId: upload.fileID,
      fileName: `source.${metadata.extension}`,
      mimeType: metadata.mimeType,
      size,
    };
  }

  private remember(jobId: string): void {
    try {
      this.pendingJobs.write(jobId);
    } catch {
      // 本地恢复能力失败不应中断已经创建的云端任务。
    }
  }

  private forget(): void {
    try {
      this.pendingJobs.clear();
    } catch {
      // 云端结果仍可正常返回。
    }
  }

  private async getGenerationJob(jobId: string): Promise<GenerationJobStatusResponse> {
    return parseGenerationJob(await this.callWithRetry({ action: "get-generation-job", jobId }));
  }

  private async waitForGenerationJob(
    initial: GenerationJobStatusResponse,
  ): Promise<GenerationApiResponse> {
    let job = initial;
    const deadline = Date.now() + GENERATION_POLL_BUDGET_MS;
    if (job.status === "queued" || job.status === "generating") {
      this.remember(job.jobId);
    }

    while (true) {
      if (job.status === "succeeded") {
        this.forget();
        return job;
      }
      if (job.status === "failed") {
        this.forget();
        throw new GenerationApiError(job.error.message, job.error.code, job.error.retryable);
      }
      if (Date.now() >= deadline) {
        throw new GenerationApiError(
          "生成任务仍在微信云端处理中，稍后重新进入小程序会自动恢复。",
          "GENERATION_POLL_TIMEOUT",
          true,
        );
      }

      try {
        job = await this.getGenerationJob(job.jobId);
      } catch (error) {
        if (error instanceof GenerationApiError && !error.retryable) {
          throw error;
        }
      }
      if (job.status === "queued" || job.status === "generating") {
        await wait(GENERATION_POLL_INTERVAL_MS);
      }
    }
  }

  async analyzeGarment(input: CreateGenerationRequest): Promise<GarmentAnalysisApiResponse> {
    const image = await this.uploadSource(input.imagePath, imageSize(input));
    return parseAnalysis(
      await this.callWithRetry({
        action: "analyze-garment",
        ...image,
        brief: createBrief(input),
      }),
    );
  }

  async createGeneration(input: CreateGenerationRequest): Promise<GenerationApiResponse> {
    const image = await this.uploadSource(input.imagePath, imageSize(input));
    const submitted = parseGenerationJob(
      await this.callWithRetry({
        action: "create-generation",
        ...image,
        brief: createBrief(input),
        ...(input.analysisId ? { analysisId: input.analysisId } : {}),
        ...(input.directionId ? { directionId: input.directionId } : {}),
        ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
      }),
    );
    return this.waitForGenerationJob(submitted);
  }

  async refineGeneration(input: RefineGenerationRequest): Promise<GenerationApiResponse> {
    const image = await this.uploadSource(input.imagePath, imageSize(input));
    const submitted = parseGenerationJob(
      await this.callWithRetry({
        action: "create-refinement",
        ...image,
        parentJobId: input.parentJobId,
        instruction: input.instruction,
      }),
    );
    return this.waitForGenerationJob(submitted);
  }

  async restorePendingGeneration(): Promise<GenerationApiResponse | null> {
    const jobId = this.pendingJobs.read();
    if (!jobId) {
      return null;
    }
    try {
      return await this.waitForGenerationJob(await this.getGenerationJob(jobId));
    } catch (error) {
      if (error instanceof GenerationApiError && error.code === "GENERATION_JOB_NOT_FOUND") {
        this.forget();
      }
      throw error;
    }
  }

  async getTrialCapabilities(): Promise<TrialCapabilities> {
    const capabilities = await this.capabilities();
    return {
      trialAccessRequired: false,
      trialDailyAnalysisLimit: capabilities.trialDailyAnalysisLimit,
      trialDailyGenerationLimit: capabilities.trialDailyGenerationLimit,
      assetRetentionHours: capabilities.assetRetentionHours,
    };
  }
}
