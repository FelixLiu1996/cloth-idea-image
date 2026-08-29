import { describe, expect, it } from "vitest";

import type { GarmentAnalysis } from "./garment-analysis";
import {
  createGarmentRefinementInstruction,
  createGarmentResultReviewPlan,
  createPreserveItemSuggestions,
  garmentRefinementAxisOptions,
  formatGarmentPreserveItem,
  parsePreserveItems,
  serializePreserveItems,
} from "./product-flow";

function fact(
  value: string | string[] | null,
  evidenceLevel: "visible" | "inferred" | "unknown" = "visible",
  confidence = 0.9,
) {
  return { value, evidenceLevel, confidence, evidence: "图片中可直接看到" };
}

const analysis: GarmentAnalysis = {
  schemaVersion: "garment-dna-v0.2",
  visualFacts: {
    category: fact("短夹克"),
    silhouette: fact("宽松箱型"),
    length: fact("腰上短款", "inferred", 0.95),
    shoulder: fact("落肩", "visible", 0.6),
    collar: fact("圆领"),
    closure: fact("中央金属拉链"),
    sleeve: fact("长袖"),
    cuff: fact("黑白格纹翻折袖口"),
    pockets: fact("双侧插袋", "inferred", 0.9),
    frontPanels: fact("纵向分割"),
    backPanels: fact(null, "unknown", 0),
    fabric: fact("深靛蓝牛仔"),
    color: fact("深靛蓝"),
    trims: fact(["银色拉链", "金属四合扣"]),
    craftsmanship: fact("浅色明线"),
    presentation: fact("衣架商品图"),
  },
  userConstraints: { preserve: ["格纹袖口"], modify: ["口袋"], avoid: [] },
  conflictsOrQuestions: [],
  designDirections: [1, 2, 3].map((number) => ({
    id: `direction-${number}` as "direction-1" | "direction-2" | "direction-3",
    name: `方向${number}`,
    summary: "复古工装方向",
    changes: [
      { area: "pockets" as const, instruction: "增加非对称工具袋", reason: "强化工装感" },
      { area: "collar" as const, instruction: "改为小立领", reason: "建立新识别点" },
    ],
    preserve: ["短款比例"],
    productionRisk: {
      level: "medium" as const,
      newPatternPieces: [],
      newTrims: [],
      newOperations: [],
      fitOrStructureRisks: [],
      reason: "需要确认口袋容量",
    },
    promptRequirements: { positive: [], hardConstraints: [], negative: [] },
  })),
  recommendedDirectionId: "direction-1",
  recommendationReason: "改款与生产风险平衡",
};

describe("preserve item confirmation", () => {
  it("normalizes manual preserve items across supported separators", () => {
    const items = parsePreserveItems("格纹袖口，深蓝牛仔、格纹袖口\n短款比例");

    expect(items).toEqual(["格纹袖口", "深蓝牛仔", "短款比例"]);
    expect(serializePreserveItems(items)).toBe("格纹袖口，深蓝牛仔，短款比例");
  });

  it("suggests only high-confidence visible garment facts", () => {
    const suggestions = createPreserveItemSuggestions(analysis);

    expect(suggestions.map((item) => item.preserveItem)).toContain("袖口：黑白格纹翻折袖口");
    expect(suggestions.map((item) => item.preserveItem)).toContain("辅料：银色拉链、金属四合扣");
    expect(suggestions.map((item) => item.factKey)).not.toEqual(
      expect.arrayContaining(["length", "shoulder", "pockets", "backPanels", "presentation"]),
    );
  });
});

describe("garment result review plan", () => {
  it("covers confirmed locks, direction changes and common anomalies", () => {
    const plan = createGarmentResultReviewPlan({
      preserveItems: ["格纹袖口"],
      direction: analysis.designDirections[0]!,
    });

    expect(plan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "preservation", title: "格纹袖口" }),
        expect.objectContaining({ kind: "preservation", title: "短款比例" }),
        expect.objectContaining({ kind: "change", title: "口袋：增加非对称工具袋" }),
        expect.objectContaining({ kind: "anomaly", title: "文字与水印" }),
      ]),
    );
  });

  it("localizes direction preserve keys and compiles selected issues into refinement text", () => {
    expect(formatGarmentPreserveItem("fabric")).toBe("面料");
    expect(formatGarmentPreserveItem("自定义结构")).toBe("自定义结构");

    const instruction = createGarmentRefinementInstruction([
      {
        id: "preservation-1",
        kind: "preservation",
        title: "领型：立领",
        instruction: "确认保留。",
      },
      {
        id: "anomaly-text-watermark",
        kind: "anomaly",
        title: "文字与水印",
        instruction: "确认没有文字。",
      },
    ]);

    expect(instruction).toContain("恢复并清晰保留“领型：立领”");
    expect(instruction).toContain("修正“文字与水印”");
    expect(instruction).toContain("其余已确认元素和设计方向保持不变");
    expect(createGarmentRefinementInstruction([])).toBe("");
  });

  it("prioritizes free-text feedback and combines it with selected issues without another model", () => {
    const instruction = createGarmentRefinementInstruction(
      [
        {
          id: "anomaly-structure-quality",
          kind: "anomaly",
          title: "结构与图像质量",
          instruction: "确认结构和画质。",
        },
      ],
      "  胸前只保留一个斜插袋，袖口格纹不变  ",
    );

    expect(instruction).toContain("用户补充要求：胸前只保留一个斜插袋，袖口格纹不变");
    expect(instruction).toContain("同时修正以下问题：修正“结构与图像质量”");
    expect(instruction).toContain("其余已确认元素和设计方向保持不变");
  });

  it("accepts free text without checklist items and keeps the compiled instruction bounded", () => {
    const instruction = createGarmentRefinementInstruction([], "袖型更宽松一点");
    const longInstruction = createGarmentRefinementInstruction([], "调整结构".repeat(200));

    expect(instruction).toBe("用户补充要求：袖型更宽松一点。其余已确认元素和设计方向保持不变。");
    expect(longInstruction.length).toBe(500);
    expect(longInstruction.endsWith("其余已确认元素和设计方向保持不变。")).toBe(true);
  });

  it("compiles a single refinement dimension without requiring free text", () => {
    const instruction = createGarmentRefinementInstruction([], "", "silhouette-proportion");

    expect(instruction).toContain("本轮只探索廓形与比例");
    expect(instruction).toContain("保持面料、色彩");
    expect(instruction).toContain("除选中维度和明确问题外");
  });

  it("combines one refinement dimension, optional feedback and review issues deterministically", () => {
    const instruction = createGarmentRefinementInstruction(
      [
        {
          id: "anomaly-text-watermark",
          kind: "anomaly",
          title: "文字与水印",
          instruction: "确认没有文字。",
        },
      ],
      "以酒红色作为局部点缀",
      "color-finish",
    );

    expect(instruction).toContain("本轮只探索色彩与工艺");
    expect(instruction).toContain("在上述范围内执行用户补充要求：以酒红色作为局部点缀");
    expect(instruction).toContain("同时修正以下问题：修正“文字与水印”");
    expect(instruction.length).toBeLessThanOrEqual(500);
  });

  it("keeps refinement axis ids unique and separates dimensions from intensity controls", () => {
    expect(new Set(garmentRefinementAxisOptions.map((option) => option.id)).size).toBe(
      garmentRefinementAxisOptions.length,
    );
    expect(
      garmentRefinementAxisOptions.filter((option) => option.kind === "dimension"),
    ).toHaveLength(3);
    expect(
      garmentRefinementAxisOptions.filter((option) => option.kind === "intensity"),
    ).toHaveLength(2);
  });
});
