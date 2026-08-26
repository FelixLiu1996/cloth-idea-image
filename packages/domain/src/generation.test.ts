import { describe, expect, it } from "vitest";

import { buildGarmentPrompt, createGenerationSummary } from "./generation";

const baseInput = {
  mode: "quick-derivative" as const,
  preserveItems: ["黑白格纹翻折袖口"],
  changeRequest: "整体改成复古铁路工装夹克",
  styleDirection: "1940—1950年代复古工装",
  intensity: "medium" as const,
  sourceImage: {
    bytes: new Uint8Array([1, 2, 3]),
    fileName: "coat.jpg",
    mimeType: "image/jpeg" as const,
  },
  outputCount: 1 as const,
  promptVersion: "garment-redesign-v1" as const,
};

describe("buildGarmentPrompt", () => {
  it("keeps hard preservation constraints and production guidance", () => {
    const prompt = buildGarmentPrompt(baseInput);

    expect(prompt).toContain("黑白格纹翻折袖口");
    expect(prompt).toContain("硬约束");
    expect(prompt).toContain("整体改成复古铁路工装夹克");
    expect(prompt).toContain("打版");
    expect(prompt).toContain("不应只停留在领型或口袋替换");
  });

  it("creates a concise user-facing summary", () => {
    expect(createGenerationSummary(baseInput)).toBe(
      "快速衍生 · 保留 黑白格纹翻折袖口 · 1940—1950年代复古工装",
    );
  });
});
