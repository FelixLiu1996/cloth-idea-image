import type { DesignDirection, GenerationApiResponse } from "@cloth-idea/domain";
import { describe, expect, it } from "vitest";

import {
  createResultChangeSummary,
  createResultComparisonReference,
  defaultResultPreview,
} from "./result-comparison";

const direction: DesignDirection = {
  id: "direction-1",
  name: "复古工装夹克",
  summary: "强化工装细节。",
  changes: [
    { area: "pockets", instruction: "增加立体贴袋", reason: "强化实用感" },
    { area: "collar", instruction: "改为小立领", reason: "收紧视觉重心" },
  ],
  preserve: ["深蓝牛仔"],
  productionRisk: {
    level: "low",
    newPatternPieces: [],
    newTrims: [],
    newOperations: [],
    fitOrStructureRisks: [],
    reason: "结构简单。",
  },
  promptRequirements: { positive: [], hardConstraints: [], negative: [] },
};

function result(overrides: Partial<GenerationApiResponse> = {}): GenerationApiResponse {
  return {
    jobId: "job-1",
    status: "succeeded",
    provider: "testing-fake",
    model: "fake-image",
    resultUrl: "https://example.com/result-1.jpg",
    summary: "测试结果",
    durationMs: 12_000,
    strategy: "analyzed",
    directionId: "direction-1",
    directionName: "复古工装夹克",
    operation: "initial",
    parentJobId: null,
    revisionInstruction: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("result comparison", () => {
  it("prefers a loaded parent version over the original source", () => {
    const parent = result();
    const current = result({
      jobId: "job-2",
      resultUrl: "https://example.com/result-2.jpg",
      operation: "refine",
      parentJobId: parent.jobId,
      revisionInstruction: "袖型更宽松",
    });

    const reference = createResultComparisonReference(
      current,
      [parent, current],
      "/tmp/source.jpg",
    );

    expect(reference).toEqual({
      kind: "version",
      label: "上一版",
      url: parent.resultUrl,
    });
    expect(defaultResultPreview(reference)).toBe("compare");
  });

  it("falls back to the original source when the parent is unavailable", () => {
    const current = result({ parentJobId: "missing-parent", operation: "regenerate" });

    expect(createResultComparisonReference(current, [current], "/tmp/source.jpg")).toEqual({
      kind: "source",
      label: "原图",
      url: "/tmp/source.jpg",
    });
  });

  it("describes refinement as an instruction, not a verified visual change", () => {
    const summary = createResultChangeSummary({
      result: result({ operation: "refine", revisionInstruction: "只保留一个胸袋" }),
      direction,
      directChangeRequest: "",
      directStyleDirection: "",
      intensityLabel: "中改",
      preserveCount: 2,
    });

    expect(summary).toMatchObject({
      title: "本轮新增修改",
      items: [{ label: "本轮追加", instruction: "只保留一个胸袋" }],
    });
    expect(summary.context).toContain("继续继承");
  });

  it("explains that regeneration keeps the same design constraints", () => {
    const summary = createResultChangeSummary({
      result: result({ operation: "regenerate", parentJobId: "job-0" }),
      direction,
      directChangeRequest: "",
      directStyleDirection: "",
      intensityLabel: "中改",
      preserveCount: 1,
    });

    expect(summary.title).toBe("同方向重新生成");
    expect(summary.context).toContain("没有新增修改指令");
    expect(summary.items).toHaveLength(2);
  });
});
