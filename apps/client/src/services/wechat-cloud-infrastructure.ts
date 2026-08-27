import type {
  SupportedImageMimeType,
  WechatCloudCapabilities,
  WechatCloudInfrastructureProbe,
  WechatCloudInfrastructureProbeDeletion,
} from "@cloth-idea/domain";
import Taro from "@tarojs/taro";

import { GenerationApiError } from "./garment-gateway";
import {
  callGarmentCloudFunction,
  type WechatCloudFunctionClient,
} from "./wechat-cloud-function-client";

export interface WechatCloudInfrastructureClient extends WechatCloudFunctionClient {
  uploadFile(options: {
    readonly cloudPath: string;
    readonly filePath: string;
  }): Promise<{ readonly fileID: string }>;
}

export interface InfrastructureProbeImage {
  readonly path: string;
  readonly size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCapabilities(value: unknown): WechatCloudCapabilities {
  if (
    !isRecord(value) ||
    value.transport !== "wechat-cloud" ||
    typeof value.authorized !== "boolean" ||
    typeof value.viewerFingerprint !== "string"
  ) {
    throw new GenerationApiError("云端能力信息无法识别。", "BAD_CLOUD_RESPONSE", true);
  }
  return value as unknown as WechatCloudCapabilities;
}

function parseProbe(value: unknown): WechatCloudInfrastructureProbe {
  if (
    !isRecord(value) ||
    value.status !== "succeeded" ||
    typeof value.probeId !== "string" ||
    typeof value.cloudFileId !== "string"
  ) {
    throw new GenerationApiError("云端探针结果无法识别。", "BAD_CLOUD_RESPONSE", true);
  }
  return value as unknown as WechatCloudInfrastructureProbe;
}

function parseProbeDeletion(value: unknown): WechatCloudInfrastructureProbeDeletion {
  if (!isRecord(value) || value.status !== "deleted" || typeof value.probeId !== "string") {
    throw new GenerationApiError("云端清理结果无法识别。", "BAD_CLOUD_RESPONSE", true);
  }
  return value as unknown as WechatCloudInfrastructureProbeDeletion;
}

function createIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function imageMetadata(path: string): {
  readonly extension: "jpg" | "png" | "webp";
  readonly mimeType: SupportedImageMimeType;
} {
  const normalizedPath = path.split("?")[0]?.toLowerCase() ?? "";
  if (normalizedPath.endsWith(".png")) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (normalizedPath.endsWith(".webp")) {
    return { extension: "webp", mimeType: "image/webp" };
  }
  return { extension: "jpg", mimeType: "image/jpeg" };
}

function configuredClient(): WechatCloudInfrastructureClient {
  return Taro.cloud as unknown as WechatCloudInfrastructureClient;
}

export async function getWechatCloudInfrastructureCapabilities(
  client: WechatCloudFunctionClient = configuredClient(),
): Promise<WechatCloudCapabilities> {
  const data = await callGarmentCloudFunction(client, { action: "get-capabilities" });
  return parseCapabilities(data);
}

export async function createWechatCloudInfrastructureProbe(
  image: InfrastructureProbeImage,
  client: WechatCloudInfrastructureClient = configuredClient(),
): Promise<WechatCloudInfrastructureProbe> {
  const capabilities = await getWechatCloudInfrastructureCapabilities(client);
  if (!capabilities.authorized) {
    throw new GenerationApiError(
      "当前微信账号尚未加入体验名单。",
      "AUTH_TRIAL_MEMBER_REQUIRED",
      false,
    );
  }
  const idempotencyKey = createIdempotencyKey();
  const metadata = imageMetadata(image.path);
  const fileName = `source.${metadata.extension}`;
  const upload = await client.uploadFile({
    cloudPath: `garment-source-temp/${capabilities.viewerFingerprint}/incoming/${idempotencyKey}.${metadata.extension}`,
    filePath: image.path,
  });
  const data = await callGarmentCloudFunction(client, {
    action: "create-infrastructure-probe",
    idempotencyKey,
    cloudFileId: upload.fileID,
    fileName,
    mimeType: metadata.mimeType,
    size: image.size,
  });
  return parseProbe(data);
}

export async function deleteWechatCloudInfrastructureProbe(
  probeId: string,
  client: WechatCloudFunctionClient = configuredClient(),
): Promise<WechatCloudInfrastructureProbeDeletion> {
  const data = await callGarmentCloudFunction(client, {
    action: "delete-infrastructure-probe",
    probeId,
  });
  return parseProbeDeletion(data);
}

export async function getWechatCloudInfrastructureProbe(
  probeId: string,
  client: WechatCloudFunctionClient = configuredClient(),
): Promise<WechatCloudInfrastructureProbe> {
  const data = await callGarmentCloudFunction(client, {
    action: "get-infrastructure-probe",
    probeId,
  });
  return parseProbe(data);
}
