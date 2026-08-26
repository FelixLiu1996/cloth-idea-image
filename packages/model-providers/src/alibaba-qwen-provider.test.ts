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
      model: string;
      messages: Array<{
        content: Array<{ text?: string; image_url?: { url: string } }>;
      }>;
      response_format: {
        type: string;
        json_schema?: { strict?: boolean; schema?: Record<string, unknown> };
      };
      enable_thinking: boolean;
      max_tokens?: number;
    };

    expect(call?.[0]).toBe("https://workspace.example.com/compatible-mode/v1/chat/completions");
    expect(body.model).toBe("qwen3.7-plus");
    expect(body.messages[0]?.content[0]?.text).toContain("garment-dna-v0.2");
    expect(body.messages[0]?.content[0]?.text).toContain("忽略图片中的商家型号");
    expect(body.messages[0]?.content[1]?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema?.strict).toBe(true);
    expect(body.response_format.json_schema?.schema?.additionalProperties).toBe(false);
    expect(body.enable_thinking).toBe(false);
    expect(body.max_tokens).toBeUndefined();
    expect(result.providerRequestId).toBe("qwen-request-1");
    expect(result.attemptCount).toBe(1);
    expect(result.usage.totalTokens).toBe(300);
    expect(result.analysis.designDirections).toHaveLength(3);
  });

  it("normalizes harmless schema drift before rejecting the analysis", async () => {
    const candidate = structuredClone(analysis) as unknown as Record<string, unknown>;
    candidate.schemaVersion = "garment-dna-v0.1";
    candidate.recommendedDirectionId = "recommended";
    const constraints = candidate.userConstraints as Record<string, unknown>;
    constraints.preserve = "错误的模型复述";
    constraints.avoid = "商家水印";
    const directions = candidate.designDirections as Array<Record<string, unknown>>;
    directions[0]!.id = "recommended";
    const firstChanges = directions[0]!.changes as Array<Record<string, unknown>>;
    firstChanges[0]!.area = "neckline";
    const risk = directions[0]!.productionRisk as Record<string, unknown>;
    risk.level = "中等";
    risk.newPatternPieces = "新领片";
    const requirements = directions[0]!.promptRequirements as Record<string, unknown>;
    requirements.positive = "真实商品摄影";

    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "qwen-normalized",
          choices: [{ message: { content: JSON.stringify(candidate) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new AlibabaQwenProvider({
      apiKey: "test-key",
      baseUrl: "https://workspace.example.com/compatible-mode/v1",
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

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(result.analysis.schemaVersion).toBe("garment-dna-v0.2");
    expect(result.analysis.userConstraints.preserve).toEqual(["格纹袖口"]);
    expect(result.analysis.userConstraints.avoid).toEqual(["商家水印"]);
    expect(result.analysis.designDirections[0]?.changes[0]?.area).toBe("collar");
    expect(result.analysis.designDirections[0]?.productionRisk).toMatchObject({
      level: "medium",
      newPatternPieces: ["新领片"],
    });
    expect(result.analysis.designDirections[0]?.promptRequirements.positive).toEqual([
      "真实商品摄影",
    ]);
    expect(result.analysis.recommendedDirectionId).toBe("direction-1");
  });

  it("repairs an invalid candidate once without resending the image", async () => {
    const invalidCandidate = structuredClone(analysis) as unknown as Record<string, unknown>;
    const directions = invalidCandidate.designDirections as Array<Record<string, unknown>>;
    directions[0]!.changes = [
      { area: "collar", instruction: "调整领座比例", reason: "强化工装结构" },
    ];
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "qwen-initial",
            choices: [{ message: { content: JSON.stringify(invalidCandidate) } }],
            usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "qwen-repair",
            choices: [{ message: { content: JSON.stringify(analysis) } }],
            usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const provider = new AlibabaQwenProvider({
      apiKey: "test-key",
      baseUrl: "https://workspace.example.com/compatible-mode/v1",
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
    const repairBody = JSON.parse(String(fetchImplementation.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(repairBody.messages[1]?.content).toContain("designDirections.0.changes");
    expect(repairBody.messages[1]?.content).not.toContain("data:image/jpeg;base64");
    expect(result.providerRequestId).toBe("qwen-repair");
    expect(result.attemptCount).toBe(2);
    expect(result.usage).toMatchObject({ inputTokens: 150, outputTokens: 300, totalTokens: 450 });
  });

  it("stops after one unsuccessful repair", async () => {
    const invalidCandidate = structuredClone(analysis) as unknown as Record<string, unknown>;
    invalidCandidate.designDirections = [];
    const invalidResponse = new Response(
      JSON.stringify({
        id: "qwen-invalid",
        choices: [{ message: { content: JSON.stringify(invalidCandidate) } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(invalidResponse)
      .mockResolvedValueOnce(invalidResponse.clone());
    const provider = new AlibabaQwenProvider({
      apiKey: "test-key",
      baseUrl: "https://workspace.example.com/compatible-mode/v1",
      fetchImplementation,
    });

    await expect(
      provider.analyze({
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
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_BAD_RESPONSE", retryable: false });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("keeps JSON Object mode for legacy vision models", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const provider = new AlibabaQwenProvider({
      apiKey: "test-key",
      baseUrl: "https://workspace.example.com/compatible-mode/v1",
      model: "qwen3-vl-plus",
      fetchImplementation,
    });

    await provider.analyze({
      sourceImage: {
        bytes: new Uint8Array([1]),
        fileName: "legacy.jpg",
        mimeType: "image/jpeg",
      },
      brief: {
        mode: "quick-derivative",
        preserveItems: [],
        changeRequest: "调整整体结构",
        styleDirection: "现代通勤",
        intensity: "medium",
      },
      schemaVersion: "garment-dna-v0.2",
    });
    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      response_format: { type: string };
      max_tokens?: number;
    };

    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(5_000);
  });
});
