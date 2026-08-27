import { describe, expect, it, vi } from "vitest";

vi.mock("@tarojs/taro", () => ({
  default: {
    uploadFile: vi.fn(),
    request: vi.fn(),
  },
}));

import { httpGarmentGateway } from "./generation-api";
import { createGarmentGateway } from "./active-garment-gateway";
import { WechatCloudGarmentGateway } from "./wechat-cloud-garment-gateway";

describe("active garment gateway", () => {
  it("keeps the existing HTTP gateway as the safe default", () => {
    expect(createGarmentGateway("http")).toBe(httpGarmentGateway);
  });

  it("creates the isolated WeChat cloud gateway when explicitly enabled", () => {
    expect(createGarmentGateway("wechat-cloud")).toBeInstanceOf(WechatCloudGarmentGateway);
  });

  it("rejects unknown gateway modes instead of silently selecting a transport", () => {
    expect(() => createGarmentGateway("unknown")).toThrow("Unsupported garment gateway mode");
  });
});
