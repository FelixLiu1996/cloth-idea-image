import { describe, expect, it } from "vitest";

import { createGarmentProvider } from "./config";

describe("createGarmentProvider", () => {
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
});
