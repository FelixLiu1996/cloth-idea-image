import { describe, expect, it } from "vitest";

import { createGarmentCloudProviderConfiguration } from "./provider-config";

describe("WeChat cloud provider configuration", () => {
  it("keeps paid providers disabled unless a supported mode is explicit", () => {
    expect(createGarmentCloudProviderConfiguration({})).toEqual({
      mode: "disabled",
      analysisProvider: null,
      imageProvider: null,
      configurationError: null,
    });
  });

  it("enables the no-cost fake mode without any model secret", () => {
    expect(
      createGarmentCloudProviderConfiguration({ WECHAT_CLOUD_BUSINESS_PROVIDER: "fake" }),
    ).toMatchObject({
      mode: "fake",
      analysisProvider: null,
      imageProvider: null,
      configurationError: null,
    });
  });

  it("fails closed when the real mode is missing server-only configuration", () => {
    expect(
      createGarmentCloudProviderConfiguration({
        WECHAT_CLOUD_BUSINESS_PROVIDER: "alibaba-qwen",
      }),
    ).toMatchObject({
      mode: "disabled",
      configurationError: "微信云端真实 Provider 缺少服务端密钥或百炼地址。",
    });
  });

  it("builds the verified Qwen analysis and image providers for the real mode", () => {
    const configuration = createGarmentCloudProviderConfiguration({
      WECHAT_CLOUD_BUSINESS_PROVIDER: "alibaba-qwen",
      DASHSCOPE_API_KEY: "server-only-test-key",
      DASHSCOPE_API_BASE_URL: "https://example.test/api/v1",
    });

    expect(configuration.mode).toBe("alibaba-qwen");
    expect(configuration.configurationError).toBeNull();
    expect(configuration.analysisProvider).toMatchObject({
      provider: "alibaba-qwen-vl",
      model: "qwen3.7-plus",
      configured: true,
    });
    expect(configuration.imageProvider).toMatchObject({
      provider: "alibaba-qwen-image",
      model: "qwen-image-2.0-pro-2026-06-22",
      configured: true,
    });
  });

  it("fails closed instead of crashing the function for invalid provider timeouts", () => {
    expect(
      createGarmentCloudProviderConfiguration({
        WECHAT_CLOUD_BUSINESS_PROVIDER: "alibaba-qwen",
        DASHSCOPE_API_KEY: "server-only-test-key",
        DASHSCOPE_API_BASE_URL: "https://example.test/api/v1",
        DASHSCOPE_GENERATION_TIMEOUT_MS: "0",
      }),
    ).toMatchObject({
      mode: "disabled",
      analysisProvider: null,
      imageProvider: null,
      configurationError: "微信云端真实 Provider 的超时配置无效。",
    });
  });
});
