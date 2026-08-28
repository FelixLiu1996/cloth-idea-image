import { describe, expect, it, vi } from "vitest";

import { callGarmentCloudFunction } from "./wechat-cloud-function-client";

describe("WeChat cloud function client", () => {
  it("accepts a JSON encoded stable envelope", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: JSON.stringify({
        ok: true,
        data: {
          transport: "wechat-cloud",
          authorized: false,
          viewerFingerprint: "abcdef1234567890",
          trialAccessRequired: false,
          trialDailyAnalysisLimit: 0,
          trialDailyGenerationLimit: 0,
          assetRetentionHours: 0,
        },
      }),
    });

    await expect(
      callGarmentCloudFunction({ callFunction }, { action: "get-capabilities" }),
    ).resolves.toMatchObject({ transport: "wechat-cloud" });
  });

  it("rejects a malformed error envelope without exposing raw fields", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: false,
        error: { message: "raw internal error", details: "database credentials" },
      },
    });

    await expect(
      callGarmentCloudFunction({ callFunction }, { action: "get-capabilities" }),
    ).rejects.toMatchObject({
      code: "BAD_CLOUD_RESPONSE",
      retryable: true,
      message: "云函数返回了无法识别的结果。",
    });
  });
});
