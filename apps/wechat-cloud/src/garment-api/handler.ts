import { createHash, randomUUID } from "node:crypto";

import type {
  ApiErrorResponse,
  CreateWechatCloudInfrastructureProbeRequest,
  DeleteWechatCloudInfrastructureProbeRequest,
  GetWechatCloudCapabilitiesRequest,
  GetWechatCloudInfrastructureProbeRequest,
  SupportedImageMimeType,
  WechatCloudCapabilities,
  WechatCloudInfrastructureProbe,
  WechatCloudInfrastructureProbeDeletion,
  WechatCloudResponse,
} from "@cloth-idea/domain";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const allowedMimeTypes = new Set<SupportedImageMimeType>(["image/jpeg", "image/png", "image/webp"]);

export interface StoredInfrastructureProbe extends WechatCloudInfrastructureProbe {
  readonly ownerFingerprint: string;
  readonly requestFingerprint: string;
}

export interface GarmentCloudRepository {
  isTrialMember(viewerFingerprint: string): Promise<boolean>;
  findInfrastructureProbe(probeId: string): Promise<StoredInfrastructureProbe | null>;
  saveInfrastructureProbe(probe: StoredInfrastructureProbe): Promise<void>;
  deleteInfrastructureProbe(probeId: string): Promise<void>;
}

export interface GarmentCloudHandlerDependencies {
  readonly getOpenId: () => string | undefined;
  readonly repository: GarmentCloudRepository;
  readonly deleteCloudFile: (cloudFileId: string) => Promise<void>;
  readonly now: () => string;
  readonly createRequestId: () => string;
  readonly trialDailyAnalysisLimit?: number;
  readonly trialDailyGenerationLimit?: number;
  readonly assetRetentionHours?: number;
}

function hash(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function apiError(
  dependencies: GarmentCloudHandlerDependencies,
  code: string,
  message: string,
  retryable: boolean,
): WechatCloudResponse {
  const error: ApiErrorResponse = {
    code,
    message,
    requestId: dependencies.createRequestId(),
    retryable,
  };
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type WechatCloudDiagnosticRequest =
  | GetWechatCloudCapabilitiesRequest
  | CreateWechatCloudInfrastructureProbeRequest
  | GetWechatCloudInfrastructureProbeRequest
  | DeleteWechatCloudInfrastructureProbeRequest;

function parseRequest(value: unknown): WechatCloudDiagnosticRequest | null {
  if (!isRecord(value) || typeof value.action !== "string") {
    return null;
  }
  if (value.action === "get-capabilities") {
    return { action: value.action };
  }
  if (value.action === "get-infrastructure-probe" && typeof value.probeId === "string") {
    return { action: value.action, probeId: value.probeId };
  }
  if (value.action === "delete-infrastructure-probe" && typeof value.probeId === "string") {
    return { action: value.action, probeId: value.probeId };
  }
  if (
    value.action === "create-infrastructure-probe" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.cloudFileId === "string" &&
    typeof value.fileName === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.size === "number" &&
    allowedMimeTypes.has(value.mimeType as SupportedImageMimeType)
  ) {
    return {
      action: value.action,
      idempotencyKey: value.idempotencyKey,
      cloudFileId: value.cloudFileId,
      fileName: value.fileName,
      mimeType: value.mimeType as SupportedImageMimeType,
      size: value.size,
    };
  }
  return null;
}

function validateProbeRequest(
  input: CreateWechatCloudInfrastructureProbeRequest,
  viewerFingerprint: string,
): string | null {
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(input.idempotencyKey)) {
    return "幂等键格式不正确。";
  }
  if (!input.cloudFileId.startsWith("cloud://") || input.cloudFileId.length > 1024) {
    return "云文件引用格式不正确。";
  }
  const extensionByMimeType: Record<SupportedImageMimeType, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const expectedPath = `/garment-source-temp/${viewerFingerprint}/incoming/${input.idempotencyKey}.${extensionByMimeType[input.mimeType]}`;
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

function publicProbe(probe: StoredInfrastructureProbe): WechatCloudInfrastructureProbe {
  return {
    probeId: probe.probeId,
    status: probe.status,
    cloudFileId: probe.cloudFileId,
    fileName: probe.fileName,
    mimeType: probe.mimeType,
    size: probe.size,
    createdAt: probe.createdAt,
  };
}

export function createGarmentCloudHandler(dependencies: GarmentCloudHandlerDependencies) {
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
        "云端请求格式不正确。",
        false,
      );
    }

    const viewerFingerprint = hash(openId, 16);

    try {
      const authorized = await dependencies.repository.isTrialMember(viewerFingerprint);

      if (request.action === "get-capabilities") {
        const capabilities: WechatCloudCapabilities = {
          transport: "wechat-cloud",
          authorized,
          viewerFingerprint,
          trialAccessRequired: false,
          trialDailyAnalysisLimit: dependencies.trialDailyAnalysisLimit ?? 0,
          trialDailyGenerationLimit: dependencies.trialDailyGenerationLimit ?? 0,
          assetRetentionHours: dependencies.assetRetentionHours ?? 0,
        };
        return { ok: true, data: capabilities };
      }

      if (!authorized) {
        return apiError(
          dependencies,
          "AUTH_TRIAL_MEMBER_REQUIRED",
          "当前微信账号尚未加入体验名单。",
          false,
        );
      }

      if (
        request.action === "get-infrastructure-probe" ||
        request.action === "delete-infrastructure-probe"
      ) {
        if (!/^[a-f0-9]{32}$/.test(request.probeId)) {
          return apiError(
            dependencies,
            "VALIDATION_PROBE_ID_INVALID",
            "探针任务编号格式不正确。",
            false,
          );
        }
        const existing = await dependencies.repository.findInfrastructureProbe(request.probeId);
        if (!existing || existing.ownerFingerprint !== viewerFingerprint) {
          return apiError(
            dependencies,
            "CLOUD_PROBE_NOT_FOUND",
            "没有找到对应的云端探针任务。",
            false,
          );
        }
        if (request.action === "delete-infrastructure-probe") {
          await dependencies.deleteCloudFile(existing.cloudFileId);
          await dependencies.repository.deleteInfrastructureProbe(existing.probeId);
          const deletion: WechatCloudInfrastructureProbeDeletion = {
            probeId: existing.probeId,
            status: "deleted",
          };
          return { ok: true, data: deletion };
        }
        return { ok: true, data: publicProbe(existing) };
      }

      const validationMessage = validateProbeRequest(request, viewerFingerprint);
      if (validationMessage) {
        return apiError(dependencies, "VALIDATION_CLOUD_PROBE_INVALID", validationMessage, false);
      }

      const probeId = hash(`probe:${openId}:${request.idempotencyKey}`);
      const requestFingerprint = hash(
        JSON.stringify({
          cloudFileId: request.cloudFileId,
          fileName: request.fileName,
          mimeType: request.mimeType,
          size: request.size,
        }),
      );
      const existing = await dependencies.repository.findInfrastructureProbe(probeId);
      if (existing) {
        if (
          existing.ownerFingerprint !== viewerFingerprint ||
          existing.requestFingerprint !== requestFingerprint
        ) {
          return apiError(
            dependencies,
            "IDEMPOTENCY_KEY_CONFLICT",
            "同一幂等键不能用于不同的云端请求。",
            false,
          );
        }
        return { ok: true, data: publicProbe(existing) };
      }

      const probe: StoredInfrastructureProbe = {
        probeId,
        status: "succeeded",
        ownerFingerprint: viewerFingerprint,
        requestFingerprint,
        cloudFileId: request.cloudFileId,
        fileName: request.fileName,
        mimeType: request.mimeType,
        size: request.size,
        createdAt: dependencies.now(),
      };
      await dependencies.repository.saveInfrastructureProbe(probe);
      return { ok: true, data: publicProbe(probe) };
    } catch {
      return apiError(
        dependencies,
        "CLOUD_STORAGE_UNAVAILABLE",
        "微信云端服务暂时不可用，请稍后重试。",
        true,
      );
    }
  };
}

export function createDefaultRequestId(): string {
  return randomUUID();
}
