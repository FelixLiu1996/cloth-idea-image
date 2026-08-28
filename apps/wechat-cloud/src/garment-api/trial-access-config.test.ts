import { describe, expect, it, vi } from "vitest";

import {
  createWechatCloudTrialAccessConfiguration,
  createWechatCloudTrialMemberAuthorizer,
} from "./trial-access-config";

describe("WeChat cloud trial access configuration", () => {
  it("keeps the fingerprint allowlist as the fail-closed default", async () => {
    const lookup = vi.fn().mockResolvedValue(false);
    const configuration = createWechatCloudTrialAccessConfiguration({});
    const authorize = createWechatCloudTrialMemberAuthorizer(configuration, lookup);

    await expect(authorize("viewer-1")).resolves.toBe(false);
    expect(configuration).toEqual({
      mode: "fingerprint-allowlist",
      experienceAccessUntil: null,
      configurationError: null,
    });
    expect(lookup).toHaveBeenCalledWith("viewer-1");
  });

  it("allows a valid WeChat experience window without a fingerprint record", async () => {
    const lookup = vi.fn().mockResolvedValue(false);
    const configuration = createWechatCloudTrialAccessConfiguration({
      WECHAT_CLOUD_TRIAL_ACCESS_MODE: "wechat-experience",
      WECHAT_CLOUD_EXPERIENCE_ACCESS_UNTIL: "2026-09-30T15:59:59.000Z",
    });
    const authorize = createWechatCloudTrialMemberAuthorizer(configuration, lookup, () =>
      Date.parse("2026-08-28T00:00:00.000Z"),
    );

    await expect(authorize("viewer-1")).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("falls back to the fingerprint allowlist after the experience window", async () => {
    const lookup = vi.fn().mockResolvedValue(true);
    const configuration = createWechatCloudTrialAccessConfiguration({
      WECHAT_CLOUD_TRIAL_ACCESS_MODE: "wechat-experience",
      WECHAT_CLOUD_EXPERIENCE_ACCESS_UNTIL: "2026-09-30T15:59:59.000Z",
    });
    const authorize = createWechatCloudTrialMemberAuthorizer(configuration, lookup, () =>
      Date.parse("2026-09-30T15:59:59.000Z"),
    );

    await expect(authorize("viewer-1")).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledWith("viewer-1");
  });

  it("rejects experience mode without a valid expiry", async () => {
    const lookup = vi.fn().mockResolvedValue(false);
    const configuration = createWechatCloudTrialAccessConfiguration({
      WECHAT_CLOUD_TRIAL_ACCESS_MODE: "wechat-experience",
      WECHAT_CLOUD_EXPERIENCE_ACCESS_UNTIL: "not-a-date",
    });
    const authorize = createWechatCloudTrialMemberAuthorizer(configuration, lookup);

    await expect(authorize("viewer-1")).resolves.toBe(false);
    expect(configuration.mode).toBe("fingerprint-allowlist");
    expect(configuration.configurationError).toContain("截止时间");
  });

  it("rejects unknown access modes", () => {
    expect(
      createWechatCloudTrialAccessConfiguration({
        WECHAT_CLOUD_TRIAL_ACCESS_MODE: "public",
      }),
    ).toMatchObject({
      mode: "fingerprint-allowlist",
      configurationError: expect.stringContaining("模式无效"),
    });
  });
});
