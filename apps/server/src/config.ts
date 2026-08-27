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
}

function readPort(value: string | undefined): number {
  const parsed = Number(value ?? "3000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("SERVER_PORT 必须是 1 到 65535 之间的整数。");
  }
  return parsed;
}

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = readPort(environment.SERVER_PORT);

  return {
    host: environment.SERVER_HOST ?? "127.0.0.1",
    port,
    publicBaseUrl: (environment.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ""),
    clientOrigin: environment.CLIENT_ORIGIN ?? "http://127.0.0.1:10086",
    assetDirectory: resolve(environment.ASSET_DIRECTORY ?? "var/assets"),
    maxUploadBytes: 10 * 1024 * 1024,
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
