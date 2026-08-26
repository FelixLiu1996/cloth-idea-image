import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  GarmentAnalysis,
  GarmentAnalysisApiResponse,
  GarmentAnalysisProviderResult,
  GarmentGenerationResult,
  GarmentImageProviderInput,
  GenerationApiResponse,
} from "@cloth-idea/domain";
import type { GarmentAnalysisProvider, GarmentImageProvider } from "@cloth-idea/model-providers";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app";
import type { ServerConfig } from "./config";

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

class FakeProvider implements GarmentImageProvider {
  readonly provider = "alibaba-wan" as const;
  readonly model = "fake-wan";
  readonly configured = true;
  readonly generateVariation = vi.fn(
    async (input: GarmentImageProviderInput): Promise<GarmentGenerationResult> => {
      void input;
      return {
        provider: this.provider,
        model: this.model,
        providerRequestId: "provider-request-1",
        durationMs: 1_250,
        assets: [{ bytes: pngBytes, mimeType: "image/png" }],
        usage: {
          generatedImages: 1,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          size: "2K",
        },
      };
    },
  );
}

function fact(
  value: string | string[] | null,
  evidenceLevel: "visible" | "inferred" | "unknown" = "visible",
  confidence = 0.9,
) {
  return { value, evidenceLevel, confidence, evidence: "集成测试证据" };
}

const analysis: GarmentAnalysis = {
  schemaVersion: "garment-dna-v0.2",
  visualFacts: {
    category: fact("短夹克"),
    silhouette: fact("宽松箱型"),
    length: fact("腰上两厘米", "inferred"),
    shoulder: fact("落肩"),
    collar: fact("立领"),
    closure: fact("单排扣"),
    sleeve: fact("长袖"),
    cuff: fact("黑白格纹翻折袖口"),
    pockets: fact("左右对称贴袋", "inferred"),
    frontPanels: fact("横向分割"),
    backPanels: fact(null, "unknown", 0),
    fabric: fact("深蓝牛仔", "inferred"),
    color: fact("深蓝色"),
    trims: fact("金属扣"),
    craftsmanship: fact("浅色明线"),
    presentation: fact("衣架商品图"),
  },
  userConstraints: {
    preserve: ["黑白格纹袖口"],
    modify: ["整体工装化"],
    avoid: ["双侧对称贴袋"],
  },
  conflictsOrQuestions: ["后片不可见"],
  designDirections: ["direction-1", "direction-2", "direction-3"].map((id, index) => ({
    id,
    name: `非对称工装${index + 1}`,
    summary: "保持原款识别度的可生产工装改款",
    changes: [
      { area: "pockets" as const, instruction: "只设置一个左侧立体袋", reason: "建立视觉重心" },
      { area: "panels" as const, instruction: "重组前片分割线", reason: "统一结构语言" },
    ],
    preserve: ["黑白格纹袖口"],
    productionRisk: {
      level: "low" as const,
      newPatternPieces: ["立体袋片"],
      newTrims: [],
      newOperations: ["立体袋缝合"],
      fitOrStructureRisks: [],
      reason: "主体版型不变",
    },
    promptRequirements: {
      positive: ["真实可打样"],
      hardConstraints: ["口袋不得左右对称"],
      negative: ["双侧对称贴袋"],
    },
  })),
  recommendedDirectionId: "direction-1",
  recommendationReason: "视觉变化和生产风险平衡",
};

class FakeAnalyzer implements GarmentAnalysisProvider {
  readonly provider = "alibaba-qwen-vl" as const;
  readonly model = "fake-qwen";
  readonly configured = true;
  readonly analyze = vi.fn(async (): Promise<GarmentAnalysisProviderResult> => ({
    provider: this.provider,
    model: this.model,
    providerRequestId: "analysis-request-1",
    durationMs: 2_500,
    attemptCount: 1,
    analysis,
    usage: {
      generatedImages: 0,
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      size: null,
    },
  }));
}

async function createMultipartRequest(
  options: {
    includeImage?: boolean;
    analysisId?: string;
    directionId?: string;
    parentJobId?: string;
    idempotencyKey?: string;
  } = {},
) {
  const form = new FormData();
  form.append("mode", "quick-derivative");
  form.append("preserveItems", "黑白格纹袖口, 深蓝牛仔面料");
  form.append("changeRequest", "改成复古工装短夹克并重做整体结构");
  form.append("styleDirection", "九十年代日系复古工装");
  form.append("intensity", "medium");
  if (options.analysisId) {
    form.append("analysisId", options.analysisId);
  }
  if (options.directionId) {
    form.append("directionId", options.directionId);
  }
  if (options.parentJobId) {
    form.append("parentJobId", options.parentJobId);
  }
  if (options.includeImage !== false) {
    form.append("sourceImage", new Blob([pngBytes], { type: "image/png" }), "jacket.png");
  }

  const request = new Request("http://localhost", { method: "POST", body: form });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    headers: {
      "content-type": request.headers.get("content-type") ?? "multipart/form-data",
      "idempotency-key": options.idempotencyKey ?? "same-request",
    },
  };
}

async function createTestContext() {
  const assetDirectory = await mkdtemp(join(tmpdir(), "cloth-idea-server-"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://example.test",
    clientOrigin: "*",
    assetDirectory,
    maxUploadBytes: 10 * 1024 * 1024,
  };
  const provider = new FakeProvider();
  const analyzer = new FakeAnalyzer();
  const app = await buildApp({ config, provider, analyzer });
  return { app, assetDirectory, provider, analyzer };
}

describe("generation API", () => {
  it("reports provider readiness", async () => {
    const context = await createTestContext();
    try {
      const response = await context.app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "ok",
        model: "fake-wan",
        providerConfigured: true,
      });
    } finally {
      await context.app.close();
      await rm(context.assetDirectory, { recursive: true, force: true });
    }
  });

  it("generates and serves a redesigned garment", async () => {
    const context = await createTestContext();
    try {
      const multipartRequest = await createMultipartRequest();
      const response = await context.app.inject({
        method: "POST",
        url: "/api/v1/generations",
        ...multipartRequest,
      });

      expect(response.statusCode).toBe(201);
      const result = response.json<GenerationApiResponse>();
      expect(result).toMatchObject({
        status: "succeeded",
        provider: "alibaba-wan",
        model: "fake-wan",
        strategy: "direct",
        directionId: null,
        operation: "initial",
        parentJobId: null,
      });
      expect(result.summary).toContain("黑白格纹袖口");
      expect(context.provider.generateVariation).toHaveBeenCalledTimes(1);

      const assetResponse = await context.app.inject({
        method: "GET",
        url: new URL(result.resultUrl).pathname,
      });
      expect(assetResponse.statusCode).toBe(200);
      expect(assetResponse.headers["content-type"]).toContain("image/png");
      expect(assetResponse.rawPayload).toEqual(Buffer.from(pngBytes));

      const repeatedResponse = await context.app.inject({
        method: "POST",
        url: "/api/v1/generations",
        ...(await createMultipartRequest()),
      });
      expect(repeatedResponse.statusCode).toBe(200);
      expect(repeatedResponse.json<GenerationApiResponse>().jobId).toBe(result.jobId);
      expect(context.provider.generateVariation).toHaveBeenCalledTimes(1);
    } finally {
      await context.app.close();
      await rm(context.assetDirectory, { recursive: true, force: true });
    }
  });

  it("returns a stable error when the source image is missing", async () => {
    const context = await createTestContext();
    try {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/v1/generations",
        ...(await createMultipartRequest({ includeImage: false })),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "IMAGE_REQUIRED",
        retryable: false,
      });
    } finally {
      await context.app.close();
      await rm(context.assetDirectory, { recursive: true, force: true });
    }
  });

  it("analyzes first and compiles only evidence-gated facts for the selected direction", async () => {
    const context = await createTestContext();
    try {
      const analysisResponse = await context.app.inject({
        method: "POST",
        url: "/api/v1/analyses",
        ...(await createMultipartRequest()),
      });
      expect(analysisResponse.statusCode).toBe(201);
      const analyzed = analysisResponse.json<GarmentAnalysisApiResponse>();
      expect(analyzed.evidenceSummary).toEqual({ accepted: 12, needsReview: 3, unknown: 1 });
      expect(context.analyzer.analyze).toHaveBeenCalledTimes(1);

      const repeatedAnalysisResponse = await context.app.inject({
        method: "POST",
        url: "/api/v1/analyses",
        ...(await createMultipartRequest()),
      });
      expect(repeatedAnalysisResponse.statusCode).toBe(200);
      expect(repeatedAnalysisResponse.json<GarmentAnalysisApiResponse>().analysisId).toBe(
        analyzed.analysisId,
      );
      expect(context.analyzer.analyze).toHaveBeenCalledTimes(1);

      const generationResponse = await context.app.inject({
        method: "POST",
        url: "/api/v1/generations",
        ...(await createMultipartRequest({
          analysisId: analyzed.analysisId,
          directionId: "direction-1",
        })),
      });

      expect(generationResponse.statusCode).toBe(201);
      const generated = generationResponse.json<GenerationApiResponse>();
      expect(generated).toMatchObject({
        strategy: "analyzed",
        directionId: "direction-1",
        directionName: "非对称工装1",
        operation: "initial",
        parentJobId: null,
      });
      const providerInput = context.provider.generateVariation.mock.calls[0]?.[0];
      expect(providerInput?.prompt).toContain("只设置一个左侧立体袋");
      expect(providerInput?.prompt).toContain("口袋不得左右对称");
      expect(providerInput?.prompt).not.toContain("腰上两厘米");
      expect(providerInput?.prompt).not.toContain("- 口袋：左右对称贴袋");
      expect(providerInput?.prompt).not.toContain("- 面料：深蓝牛仔");

      const regeneratedResponse = await context.app.inject({
        method: "POST",
        url: "/api/v1/generations",
        ...(await createMultipartRequest({
          analysisId: analyzed.analysisId,
          directionId: "direction-1",
          parentJobId: generated.jobId,
          idempotencyKey: "regenerate-request",
        })),
      });
      expect(regeneratedResponse.statusCode).toBe(201);
      const regenerated = regeneratedResponse.json<GenerationApiResponse>();
      expect(regenerated).toMatchObject({
        operation: "regenerate",
        parentJobId: generated.jobId,
        directionId: "direction-1",
      });

      const refinementResponse = await context.app.inject({
        method: "POST",
        url: `/api/v1/generations/${regenerated.jobId}/refinements`,
        headers: { "idempotency-key": "refinement-request" },
        payload: { instruction: "袖型再宽松一点，但保留格纹袖口" },
      });
      expect(refinementResponse.statusCode).toBe(201);
      const refined = refinementResponse.json<GenerationApiResponse>();
      expect(refined).toMatchObject({
        operation: "refine",
        parentJobId: regenerated.jobId,
        revisionInstruction: "袖型再宽松一点，但保留格纹袖口",
        directionId: "direction-1",
      });
      const refinementProviderInput = context.provider.generateVariation.mock.calls[2]?.[0];
      expect(refinementProviderInput?.sourceImage.fileName).toBe("result.png");
      expect(refinementProviderInput?.promptVersion).toBe("garment-iteration-v1");
      expect(refinementProviderInput?.prompt).toContain("口袋不得左右对称");
      expect(refinementProviderInput?.prompt).toContain("袖型再宽松一点，但保留格纹袖口");

      const repeatedRefinementResponse = await context.app.inject({
        method: "POST",
        url: `/api/v1/generations/${regenerated.jobId}/refinements`,
        headers: { "idempotency-key": "refinement-request" },
        payload: { instruction: "袖型再宽松一点，但保留格纹袖口" },
      });
      expect(repeatedRefinementResponse.statusCode).toBe(200);
      expect(repeatedRefinementResponse.json<GenerationApiResponse>().jobId).toBe(refined.jobId);
      expect(context.provider.generateVariation).toHaveBeenCalledTimes(3);

      let lastRefined = refined;
      for (let index = 2; index <= 5; index += 1) {
        const nextRefinementResponse = await context.app.inject({
          method: "POST",
          url: `/api/v1/generations/${lastRefined.jobId}/refinements`,
          headers: { "idempotency-key": `refinement-request-${index}` },
          payload: { instruction: `第 ${index} 次继续调整局部结构` },
        });
        expect(nextRefinementResponse.statusCode).toBe(201);
        lastRefined = nextRefinementResponse.json<GenerationApiResponse>();
      }

      const overLimitResponse = await context.app.inject({
        method: "POST",
        url: `/api/v1/generations/${lastRefined.jobId}/refinements`,
        headers: { "idempotency-key": "refinement-over-limit" },
        payload: { instruction: "第六次修改不应触发模型" },
      });
      expect(overLimitResponse.statusCode).toBe(409);
      expect(overLimitResponse.json()).toMatchObject({
        code: "REFINEMENT_LIMIT_REACHED",
        retryable: false,
      });
      expect(context.provider.generateVariation).toHaveBeenCalledTimes(7);

      const mismatchedParentResponse = await context.app.inject({
        method: "POST",
        url: "/api/v1/generations",
        ...(await createMultipartRequest({
          analysisId: analyzed.analysisId,
          directionId: "direction-2",
          parentJobId: generated.jobId,
          idempotencyKey: "mismatched-parent-request",
        })),
      });
      expect(mismatchedParentResponse.statusCode).toBe(409);
      expect(mismatchedParentResponse.json()).toMatchObject({
        code: "PARENT_GENERATION_MISMATCH",
        retryable: false,
      });
      expect(context.provider.generateVariation).toHaveBeenCalledTimes(7);
    } finally {
      await context.app.close();
      await rm(context.assetDirectory, { recursive: true, force: true });
    }
  });
});
