import {
  AlibabaQwenImageProvider,
  AlibabaQwenProvider,
  type GarmentAnalysisProvider,
  type GarmentImageProvider,
} from "@cloth-idea/model-providers";

export type GarmentCloudBusinessProviderMode = "disabled" | "fake" | "alibaba-qwen";

export interface GarmentCloudProviderConfiguration {
  readonly mode: GarmentCloudBusinessProviderMode;
  readonly analysisProvider: GarmentAnalysisProvider | null;
  readonly imageProvider: GarmentImageProvider | null;
  readonly configurationError: string | null;
}

function readPositiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function compatibleBaseUrl(environment: NodeJS.ProcessEnv): string | undefined {
  return (
    environment.DASHSCOPE_COMPATIBLE_BASE_URL?.trim() ||
    environment.DASHSCOPE_API_BASE_URL?.trim().replace(/\/api\/v1\/?$/, "/compatible-mode/v1")
  );
}

export function createGarmentCloudProviderConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): GarmentCloudProviderConfiguration {
  const requestedMode = environment.WECHAT_CLOUD_BUSINESS_PROVIDER?.trim();
  if (requestedMode === "fake") {
    return {
      mode: "fake",
      analysisProvider: null,
      imageProvider: null,
      configurationError: null,
    };
  }
  if (requestedMode !== "alibaba-qwen") {
    return {
      mode: "disabled",
      analysisProvider: null,
      imageProvider: null,
      configurationError:
        requestedMode && requestedMode !== "disabled" ? "微信云端业务 Provider 模式无效。" : null,
    };
  }

  const apiKey = environment.DASHSCOPE_API_KEY?.trim();
  const apiBaseUrl = environment.DASHSCOPE_API_BASE_URL?.trim();
  const visionBaseUrl = compatibleBaseUrl(environment);
  if (!apiKey || !apiBaseUrl || !visionBaseUrl) {
    return {
      mode: "disabled",
      analysisProvider: null,
      imageProvider: null,
      configurationError: "微信云端真实 Provider 缺少服务端密钥或百炼地址。",
    };
  }

  try {
    return {
      mode: "alibaba-qwen",
      analysisProvider: new AlibabaQwenProvider({
        apiKey,
        baseUrl: visionBaseUrl,
        model: environment.DASHSCOPE_VISION_MODEL?.trim() || "qwen3.7-plus",
        requestTimeoutMs: readPositiveInteger(
          environment,
          "DASHSCOPE_ANALYSIS_TIMEOUT_MS",
          150_000,
        ),
      }),
      imageProvider: new AlibabaQwenImageProvider({
        apiKey,
        baseUrl: apiBaseUrl,
        model: environment.DASHSCOPE_IMAGE_MODEL?.trim() || "qwen-image-2.0-pro-2026-06-22",
        requestTimeoutMs: readPositiveInteger(
          environment,
          "DASHSCOPE_GENERATION_TIMEOUT_MS",
          150_000,
        ),
      }),
      configurationError: null,
    };
  } catch {
    return {
      mode: "disabled",
      analysisProvider: null,
      imageProvider: null,
      configurationError: "微信云端真实 Provider 的超时配置无效。",
    };
  }
}
