import type { WechatCloudCapabilities } from "@cloth-idea/domain";
import Taro from "@tarojs/taro";

import { GenerationApiError, type GarmentGateway, type TrialCapabilities } from "./garment-gateway";
import {
  callGarmentCloudFunction,
  type WechatCloudFunctionClient,
} from "./wechat-cloud-function-client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloudBackendNotDeployed(): GenerationApiError {
  return new GenerationApiError(
    "微信云端模型服务尚未部署，请暂时使用 H5 本地链路。",
    "CLOUD_BACKEND_NOT_DEPLOYED",
    false,
  );
}

export class WechatCloudGarmentGateway implements GarmentGateway {
  constructor(private readonly cloud: WechatCloudFunctionClient = Taro.cloud) {}

  analyzeGarment(): Promise<never> {
    return Promise.reject(cloudBackendNotDeployed());
  }

  createGeneration(): Promise<never> {
    return Promise.reject(cloudBackendNotDeployed());
  }

  refineGeneration(): Promise<never> {
    return Promise.reject(cloudBackendNotDeployed());
  }

  async getTrialCapabilities(): Promise<TrialCapabilities> {
    const data = await callGarmentCloudFunction(this.cloud, { action: "get-capabilities" });
    if (
      !isRecord(data) ||
      data.transport !== "wechat-cloud" ||
      typeof data.viewerFingerprint !== "string" ||
      typeof data.authorized !== "boolean"
    ) {
      throw new GenerationApiError("云端能力信息无法识别。", "BAD_CLOUD_RESPONSE", true);
    }
    const capabilities = data as WechatCloudCapabilities;
    return {
      trialAccessRequired: false,
      trialDailyAnalysisLimit: capabilities.trialDailyAnalysisLimit,
      trialDailyGenerationLimit: capabilities.trialDailyGenerationLimit,
      assetRetentionHours: capabilities.assetRetentionHours,
    };
  }
}
