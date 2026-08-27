import { describe, expect, it, vi } from "vitest";

vi.mock("@tarojs/taro", () => ({
  default: { cloud: { callFunction: vi.fn() } },
}));

import { WechatCloudGarmentGateway } from "./wechat-cloud-garment-gateway";
import type { WechatCloudFunctionClient } from "./wechat-cloud-function-client";

describe("WeChat cloud garment gateway", () => {
  it("loads capabilities through the isolated garment cloud function", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: true,
        data: {
          transport: "wechat-cloud",
          authorized: true,
          viewerFingerprint: "abcdef1234567890",
          trialAccessRequired: false,
          trialDailyAnalysisLimit: 10,
          trialDailyGenerationLimit: 15,
          assetRetentionHours: 72,
        },
      },
    });
    const gateway = new WechatCloudGarmentGateway({ callFunction } as WechatCloudFunctionClient);

    await expect(gateway.getTrialCapabilities()).resolves.toEqual({
      trialAccessRequired: false,
      trialDailyAnalysisLimit: 10,
      trialDailyGenerationLimit: 15,
      assetRetentionHours: 72,
    });
    expect(callFunction).toHaveBeenCalledWith({
      name: "garment-api",
      data: { action: "get-capabilities" },
    });
  });

  it("maps stable cloud errors without exposing raw cloud details", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: false,
        error: {
          code: "AUTH_TRIAL_MEMBER_REQUIRED",
          message: "当前微信账号尚未加入体验名单。",
          requestId: "request-1",
          retryable: false,
        },
      },
    });
    const gateway = new WechatCloudGarmentGateway({ callFunction } as WechatCloudFunctionClient);

    await expect(gateway.getTrialCapabilities()).rejects.toMatchObject({
      code: "AUTH_TRIAL_MEMBER_REQUIRED",
      retryable: false,
    });
  });

  it("normalizes cloud invocation failures", async () => {
    const callFunction = vi.fn().mockRejectedValue(new Error("internal cloud details"));
    const gateway = new WechatCloudGarmentGateway({ callFunction } as WechatCloudFunctionClient);

    await expect(gateway.getTrialCapabilities()).rejects.toMatchObject({
      code: "CLOUD_FUNCTION_UNAVAILABLE",
      retryable: true,
      message: "无法连接微信云端服务，请稍后重试。",
    });
  });
});
