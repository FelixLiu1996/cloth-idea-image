import { resolve } from "node:path";

import {
  AlibabaQwenProvider,
  AlibabaQwenImageProvider,
  AlibabaWanProvider,
  type GarmentAnalysisProvider,
  type GarmentImageProvider,
  UnconfiguredGarmentAnalysisProvider,
  UnconfiguredGarmentImageProvider,
} from "@cloth-idea/model-providers";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly clientOrigin: string;
  readonly assetDirectory: string;
  readonly maxUploadBytes: number;
  readonly trialAccessCode: string | null;
  readonly trialDailyAnalysisLimit: number;
  readonly trialDailyGenerationLimit: number;
  readonly trialMaxConcurrentModelRequests: number;
  readonly trialGenerationMinIntervalMs: number;
  readonly assetRetentionMs: number;
  readonly assetCleanupIntervalMs: number;
}

function readPort(value: string | undefined): number {
  const parsed = Number(value ?? "3000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("SERVER_PORT 必须是 1 到 65535 之间的整数。");
  }
  return parsed;
}

function readNonNegativeInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} 必须是大于或等于 0 的整数。`);
  }
  return parsed;
}

function readPositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = readNonNegativeInteger(name, value, fallback);
  if (parsed < 1) {
    throw new Error(`${name} 必须是大于或等于 1 的整数。`);
  }
  return parsed;
}

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = readPort(environment.SERVER_PORT);
  const assetRetentionHours = readNonNegativeInteger(
    "ASSET_RETENTION_HOURS",
    environment.ASSET_RETENTION_HOURS,
    0,
  );

  return {
    host: environment.SERVER_HOST ?? "127.0.0.1",
    port,
    publicBaseUrl: (environment.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ""),
    clientOrigin: environment.CLIENT_ORIGIN ?? "http://127.0.0.1:10086",
    assetDirectory: resolve(environment.ASSET_DIRECTORY ?? "var/assets"),
    maxUploadBytes: 10 * 1024 * 1024,
    trialAccessCode: environment.TRIAL_ACCESS_CODE?.trim() || null,
    trialDailyAnalysisLimit: readNonNegativeInteger(
      "TRIAL_DAILY_ANALYSIS_LIMIT",
      environment.TRIAL_DAILY_ANALYSIS_LIMIT,
      20,
    ),
    trialDailyGenerationLimit: readNonNegativeInteger(
      "TRIAL_DAILY_GENERATION_LIMIT",
      environment.TRIAL_DAILY_GENERATION_LIMIT,
      30,
    ),
    trialMaxConcurrentModelRequests: readPositiveInteger(
      "TRIAL_MAX_CONCURRENT_MODEL_REQUESTS",
      environment.TRIAL_MAX_CONCURRENT_MODEL_REQUESTS,
      1,
    ),
    trialGenerationMinIntervalMs: readNonNegativeInteger(
      "TRIAL_GENERATION_MIN_INTERVAL_MS",
      environment.TRIAL_GENERATION_MIN_INTERVAL_MS,
      31_000,
    ),
    assetRetentionMs: assetRetentionHours * 60 * 60 * 1_000,
    assetCleanupIntervalMs: 60 * 60 * 1_000,
  };
}

export function createGarmentProvider(
  environment: NodeJS.ProcessEnv = process.env,
): GarmentImageProvider {
  const providerName = environment.MODEL_PROVIDER ?? "alibaba-qwen-image";
  if (providerName !== "alibaba-wan" && providerName !== "alibaba-qwen-image") {
    throw new Error(`不支持的 MODEL_PROVIDER：${providerName}`);
  }

  const model =
    environment.DASHSCOPE_IMAGE_MODEL ??
    (providerName === "alibaba-qwen-image" ? "qwen-image-2.0-pro-2026-06-22" : "wan2.7-image-pro");
  const apiKey = environment.DASHSCOPE_API_KEY;
  const baseUrl = environment.DASHSCOPE_API_BASE_URL;

  if (!apiKey || !baseUrl) {
    return new UnconfiguredGarmentImageProvider(model, providerName);
  }

  if (providerName === "alibaba-qwen-image") {
    return new AlibabaQwenImageProvider({
      apiKey,
      baseUrl,
      model,
    });
  }

  return new AlibabaWanProvider({
    apiKey,
    baseUrl,
    model,
  });
}

export function createGarmentAnalyzer(
  environment: NodeJS.ProcessEnv = process.env,
): GarmentAnalysisProvider {
  const model = environment.DASHSCOPE_VISION_MODEL ?? "qwen3.7-plus";
  const apiKey = environment.DASHSCOPE_API_KEY;
  const baseUrl =
    environment.DASHSCOPE_COMPATIBLE_BASE_URL ??
    environment.DASHSCOPE_API_BASE_URL?.replace(/\/api\/v1\/?$/, "/compatible-mode/v1");

  if (!apiKey || !baseUrl) {
    return new UnconfiguredGarmentAnalysisProvider(model);
  }

  return new AlibabaQwenProvider({
    apiKey,
    baseUrl,
    model,
  });
}
