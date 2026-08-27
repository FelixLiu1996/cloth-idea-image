import { describe, expect, it, vi } from "vitest";

vi.mock("@tarojs/taro", () => ({
  default: { cloud: { init: vi.fn() } },
}));

import { initializeWechatCloud } from "./wechat-cloud-platform";

describe("WeChat cloud platform", () => {
  it("initializes the configured environment for WeChat builds", () => {
    const init = vi.fn();

    initializeWechatCloud({
      platform: "weapp",
      environmentId: "cloud-test-123",
      cloud: { init },
    });

    expect(init).toHaveBeenCalledWith({ env: "cloud-test-123", traceUser: true });
  });

  it("does not touch the WeChat cloud runtime in H5 builds", () => {
    const init = vi.fn();

    initializeWechatCloud({ platform: "h5", environmentId: "", cloud: { init } });

    expect(init).not.toHaveBeenCalled();
  });

  it("fails early when a WeChat build has no environment ID", () => {
    expect(() =>
      initializeWechatCloud({ platform: "weapp", environmentId: " ", cloud: { init: vi.fn() } }),
    ).toThrow("TARO_APP_WECHAT_CLOUD_ENV_ID");
  });
});
