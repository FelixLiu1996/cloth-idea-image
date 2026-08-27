import { describe, expect, it } from "vitest";

import { createGarmentProvider, loadServerConfig } from "./config";

describe("createGarmentProvider", () => {
  it("uses Qwen Image as the development default", () => {
    const provider = createGarmentProvider({
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_API_BASE_URL: "https://workspace.example.com/api/v1",
    });

    expect(provider.provider).toBe("alibaba-qwen-image");
    expect(provider.model).toBe("qwen-image-2.0-pro-2026-06-22");
  });

  it("selects the Qwen Image provider and its pinned default model", () => {
    const provider = createGarmentProvider({
      MODEL_PROVIDER: "alibaba-qwen-image",
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_API_BASE_URL: "https://workspace.example.com/api/v1",
    });

    expect(provider.provider).toBe("alibaba-qwen-image");
    expect(provider.model).toBe("qwen-image-2.0-pro-2026-06-22");
    expect(provider.configured).toBe(true);
  });

  it("keeps Wan available as an explicit fallback", () => {
    const provider = createGarmentProvider({
      MODEL_PROVIDER: "alibaba-wan",
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_API_BASE_URL: "https://workspace.example.com/api/v1",
    });

    expect(provider.provider).toBe("alibaba-wan");
    expect(provider.model).toBe("wan2.7-image-pro");
  });
});

describe("loadServerConfig", () => {
  it("uses conservative single-process trial limits", () => {
    const config = loadServerConfig({});

    expect(config).toMatchObject({
      trialAccessCode: null,
      trialDailyAnalysisLimit: 20,
      trialDailyGenerationLimit: 30,
      trialMaxConcurrentModelRequests: 1,
      trialGenerationMinIntervalMs: 31_000,
      assetRetentionMs: 0,
    });
  });

  it("reads access, quota and retention overrides", () => {
    const config = loadServerConfig({
      TRIAL_ACCESS_CODE: " private-code ",
      TRIAL_DAILY_ANALYSIS_LIMIT: "3",
      TRIAL_DAILY_GENERATION_LIMIT: "5",
      TRIAL_MAX_CONCURRENT_MODEL_REQUESTS: "2",
      TRIAL_GENERATION_MIN_INTERVAL_MS: "0",
      ASSET_RETENTION_HOURS: "72",
    });

    expect(config).toMatchObject({
      trialAccessCode: "private-code",
      trialDailyAnalysisLimit: 3,
      trialDailyGenerationLimit: 5,
      trialMaxConcurrentModelRequests: 2,
      trialGenerationMinIntervalMs: 0,
      assetRetentionMs: 72 * 60 * 60 * 1_000,
    });
  });

  it("rejects invalid trial limits", () => {
    expect(() => loadServerConfig({ TRIAL_MAX_CONCURRENT_MODEL_REQUESTS: "0" })).toThrow(
      "TRIAL_MAX_CONCURRENT_MODEL_REQUESTS",
    );
  });
});
