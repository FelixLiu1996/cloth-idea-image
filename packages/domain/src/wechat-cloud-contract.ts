import type { ApiErrorResponse, SupportedImageMimeType } from "./generation";

export interface WechatCloudCapabilities {
  readonly transport: "wechat-cloud";
  readonly authorized: boolean;
  readonly viewerFingerprint: string;
  readonly trialAccessRequired: false;
  readonly trialDailyAnalysisLimit: number;
  readonly trialDailyGenerationLimit: number;
  readonly assetRetentionHours: number;
}

export interface WechatCloudInfrastructureProbe {
  readonly probeId: string;
  readonly status: "succeeded";
  readonly cloudFileId: string;
  readonly fileName: string;
  readonly mimeType: SupportedImageMimeType;
  readonly size: number;
  readonly createdAt: string;
}

export interface WechatCloudInfrastructureProbeDeletion {
  readonly probeId: string;
  readonly status: "deleted";
}

export interface GetWechatCloudCapabilitiesRequest {
  readonly action: "get-capabilities";
}

export interface CreateWechatCloudInfrastructureProbeRequest {
  readonly action: "create-infrastructure-probe";
  readonly idempotencyKey: string;
  readonly cloudFileId: string;
  readonly fileName: string;
  readonly mimeType: SupportedImageMimeType;
  readonly size: number;
}

export interface GetWechatCloudInfrastructureProbeRequest {
  readonly action: "get-infrastructure-probe";
  readonly probeId: string;
}

export interface DeleteWechatCloudInfrastructureProbeRequest {
  readonly action: "delete-infrastructure-probe";
  readonly probeId: string;
}

export type WechatCloudRequest =
  | GetWechatCloudCapabilitiesRequest
  | CreateWechatCloudInfrastructureProbeRequest
  | GetWechatCloudInfrastructureProbeRequest
  | DeleteWechatCloudInfrastructureProbeRequest;

export type WechatCloudSuccessData =
  WechatCloudCapabilities | WechatCloudInfrastructureProbe | WechatCloudInfrastructureProbeDeletion;

export interface WechatCloudSuccessResponse {
  readonly ok: true;
  readonly data: WechatCloudSuccessData;
}

export interface WechatCloudErrorResponse {
  readonly ok: false;
  readonly error: ApiErrorResponse;
}

export type WechatCloudResponse = WechatCloudSuccessResponse | WechatCloudErrorResponse;
