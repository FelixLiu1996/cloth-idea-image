import type { GarmentAnalysis } from "@cloth-idea/domain";
import { describe, expect, it, vi } from "vitest";

import { AlibabaQwenProvider } from "./alibaba-qwen-provider";

function fact(value: string | null, evidenceLevel: "visible" | "unknown" = "visible") {
  return {
    value,
    evidenceLevel,
    confidence: evidenceLevel === "visible" ? 0.9 : 0,
    evidence: evidenceLevel === "visible" ? "图片中可见" : "当前图片不可见",
  };
}

const analysis: GarmentAnalysis = {
  schemaVersion: "garment-dna-v0.2",
  visualFacts: {
    category: fact("夹克"),
    silhouette: fact("宽松箱型"),
    length: fact(null, "unknown"),
    shoulder: fact("落肩"),
    collar: fact("立领"),
    closure: fact("单排扣"),
    sleeve: fact("长袖"),
    cuff: fact("格纹翻折袖口"),
    pockets: fact(null, "unknown"),
    frontPanels: fact("横向分割"),
    backPanels: fact(null, "unknown"),
    fabric: fact("深色梭织面料"),
    color: fact("深蓝色"),
    trims: fact("金属扣"),
    craftsmanship: fact("浅色明线"),
    presentation: fact("衣架商品图"),
  },
  userConstraints: {
    preserve: ["格纹袖口"],
    modify: ["整体工装化"],
    avoid: [],
  },
  conflictsOrQuestions: ["后片不可见"],
  designDirections: ["direction-1", "direction-2", "direction-3"].map((id, index) => ({
    id,
    name: `工装方向${index + 1}`,
    summary: "保持原款识别度的整体工装改款",
    changes: [
      { area: "collar" as const, instruction: "调整领座比例", reason: "强化工装结构" },
      { area: "panels" as const, instruction: "重组前片分割", reason: "形成统一设计语言" },
    ],
    preserve: ["格纹袖口"],
    productionRisk: {
      level: "low" as const,
      newPatternPieces: [],
      newTrims: [],
      newOperations: [],
      fitOrStructureRisks: [],
      reason: "沿用主体版型",
    },
    promptRequirements: {
      positive: ["真实商品摄影"],
      hardConstraints: ["保留格纹袖口"],
      negative: ["左右结构矛盾"],
    },
  })),
  recommendedDirectionId: "direction-1",
  recommendationReason: "改款辨识度和生产风险较均衡",
};

describe("AlibabaQwenProvider", () => {
  it("sends the source image and validates garment-dna-v0.2", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "qwen-request-1",
          choices: [{ message: { content: JSON.stringify(analysis) } }],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new AlibabaQwenProvider({
      apiKey: "test-key",
      baseUrl: "https://workspace.example.com/compatible-mode/v1/",
      fetchImplementation,
    });

    const result = await provider.analyze({
      sourceImage: {
        bytes: new Uint8Array([1, 2, 3]),
        fileName: "jacket.jpg",
        mimeType: "image/jpeg",
      },
      brief: {
        mode: "quick-derivative",
        preserveItems: ["格纹袖口"],
        changeRequest: "改成复古工装款",
        styleDirection: "日系复古工装",
        intensity: "medium",
      },
      schemaVersion: "garment-dna-v0.2",
    });
    const call = fetchImplementation.mock.calls[0];
    const body = JSON.parse(String(call?.[1]?.body)) as {
      messages: Array<{
        content: Array<{ text?: string; image_url?: { url: string } }>;
      }>;
      response_format: { type: string };
    };

    expect(call?.[0]).toBe("https://workspace.example.com/compatible-mode/v1/chat/completions");
    expect(body.messages[0]?.content[0]?.text).toContain("garment-dna-v0.2");
    expect(body.messages[0]?.content[1]?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(result.providerRequestId).toBe("qwen-request-1");
    expect(result.usage.totalTokens).toBe(300);
    expect(result.analysis.designDirections).toHaveLength(3);
  });
});
