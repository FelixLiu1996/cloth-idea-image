import { describe, expect, it } from "vitest";

import { applyEvidenceGate, garmentAnalysisSchema, type GarmentAnalysis } from "./garment-analysis";
import { compileAnalyzedGarmentPrompt, compileGarmentIterationPrompt } from "./prompt-compiler";

function fact(
  value: string | string[] | null,
  evidenceLevel: "visible" | "inferred" | "unknown" = "visible",
  confidence = 0.9,
) {
  return { value, evidenceLevel, confidence, evidence: "固定测试证据" };
}

const analysis: GarmentAnalysis = {
  schemaVersion: "garment-dna-v0.2",
  visualFacts: {
    category: fact("短夹克"),
    silhouette: fact("宽松箱型"),
    length: fact("腰上2厘米", "inferred", 0.95),
    shoulder: fact("落肩", "visible", 0.6),
    collar: fact("立领"),
    closure: fact("单排扣"),
    sleeve: fact("长袖"),
    cuff: fact("黑白格纹翻折袖口"),
    pockets: fact("左胸翻盖袋", "inferred", 0.8),
    frontPanels: fact("横向分割"),
    backPanels: fact(null, "unknown", 0),
    fabric: fact("深靛蓝牛仔", "inferred", 0.85),
    color: fact("深靛蓝"),
    trims: fact("金属扣"),
    craftsmanship: fact("浅色明线"),
    presentation: fact("衣架商品图"),
  },
  userConstraints: {
    preserve: ["黑白格纹翻折袖口"],
    modify: ["领型", "口袋"],
    avoid: ["复古铁路制服元素"],
  },
  conflictsOrQuestions: ["后片结构不可见"],
  designDirections: [1, 2, 3].map((number) => ({
    id: `direction-${number}` as "direction-1" | "direction-2" | "direction-3",
    name: `方向${number}`,
    summary: "现代解构工装",
    changes: [
      { area: "collar" as const, instruction: "改为现代半高领", reason: "弱化制服感" },
      { area: "pockets" as const, instruction: "只设置一个左侧立体袋", reason: "形成非对称视觉" },
    ],
    preserve: ["短款箱型比例"],
    productionRisk: {
      level: "medium" as const,
      newPatternPieces: ["领片"],
      newTrims: [],
      newOperations: ["领片缝合"],
      fitOrStructureRisks: ["领口贴合度"],
      reason: "需要一次打样确认领口",
    },
    promptRequirements: {
      positive: ["现代简洁"],
      hardConstraints: ["口袋不得左右对称"],
      negative: ["双侧对称贴袋"],
    },
  })),
  recommendedDirectionId: "direction-1",
  recommendationReason: "改款幅度与生产风险平衡",
};

describe("garment analysis evidence gate", () => {
  it("only accepts high-confidence visible facts", () => {
    const gate = applyEvidenceGate(analysis.visualFacts);

    expect(gate.accepted.map(({ key }) => key)).toContain("collar");
    expect(gate.needsReview.map(({ key }) => key)).toEqual(
      expect.arrayContaining(["length", "shoulder", "pockets", "fabric"]),
    );
    expect(gate.unknown.map(({ key }) => key)).toContain("backPanels");
  });

  it("validates the complete versioned schema", () => {
    expect(garmentAnalysisSchema.safeParse(analysis).success).toBe(true);
  });
});

describe("compileAnalyzedGarmentPrompt", () => {
  it("compiles selected structured changes without leaking uncertain facts", () => {
    const prompt = compileAnalyzedGarmentPrompt({
      request: {
        mode: "quick-derivative",
        preserveItems: ["格纹袖口"],
        changeRequest: "整体改成现代工装",
        styleDirection: "当代日系工装",
        intensity: "medium",
        sourceImage: {
          bytes: new Uint8Array([1]),
          fileName: "source.jpg",
          mimeType: "image/jpeg",
        },
        outputCount: 1,
        promptVersion: "garment-analysis-v1",
      },
      analysis,
      direction: analysis.designDirections[0]!,
    });

    expect(prompt).toContain("只设置一个左侧立体袋");
    expect(prompt).toContain("口袋不得左右对称");
    expect(prompt).not.toContain("腰上2厘米");
    expect(prompt).not.toContain("左胸翻盖袋");
    expect(prompt).not.toContain("深靛蓝牛仔");
    expect(prompt).toContain("inferred、unknown 或低置信度区域");
  });

  it("keeps the deterministic base prompt while adding cumulative revision instructions", () => {
    const prompt = compileGarmentIterationPrompt({
      basePrompt: "必须完整保留：格纹袖口。\n禁止出现：品牌标志。",
      revisionInstructions: ["袖型再宽松一点", "门襟改成隐藏拉链", "袖型再宽松一点"],
    });

    expect(prompt).toContain("必须完整保留：格纹袖口");
    expect(prompt).toContain("禁止出现：品牌标志");
    expect(prompt).toContain("1. 袖型再宽松一点");
    expect(prompt).toContain("2. 门襟改成隐藏拉链");
    expect(prompt).toContain("本轮重点：门襟改成隐藏拉链");
    expect(prompt.match(/袖型再宽松一点/g)).toHaveLength(1);
  });
});
