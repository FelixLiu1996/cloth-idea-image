import { describe, expect, it } from "vitest";

import { createGarmentProvider } from "./config";

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
