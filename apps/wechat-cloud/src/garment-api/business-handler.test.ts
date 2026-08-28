import { createHash } from "node:crypto";

import {
  MemoryGarmentAnalysisRepository,
  MemoryGarmentAssetRepository,
  MemoryGenerationTaskRepository,
  MemoryIdempotencyRepository,
  MemoryTransactionRunner,
  MemoryTrialQuotaRepository,
  GenerationTaskAdmissionService,
  GenerationTaskExecutionService,
} from "@cloth-idea/application";
import { garmentAnalysisSchema, garmentFactKeys } from "@cloth-idea/domain";
import {
  GarmentProviderError,
  type GarmentAnalysisProvider,
  type GarmentImageProvider,
} from "@cloth-idea/model-providers";
import { describe, expect, it, vi } from "vitest";

import {
  createGarmentCloudBusinessHandler,
  type GarmentCloudBusinessHandlerDependencies,
} from "./business-handler";

const now = "2026-08-27T12:00:00.000Z";
const ownerId = createHash("sha256").update("openid-user-1").digest("hex").slice(0, 16);

class MemoryAssetStorage {
  readonly files = new Map<string, Uint8Array>();
  saveCount = 0;

  read(fileId: string): Promise<Uint8Array> {
    const bytes = this.files.get(fileId);
    if (!bytes) {
      return Promise.reject(new Error("missing file"));
    }
    return Promise.resolve(bytes);
  }

  save(input: {
    readonly ownerId: string;
    readonly assetId: string;
    readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
    readonly bytes: Uint8Array;
  }): Promise<{ readonly fileId: string; readonly cloudPath: string; readonly size: number }> {
    this.saveCount += 1;
    const fileId = `cloud://env/garment-results/${input.ownerId}/${input.assetId}/result.jpg`;
    this.files.set(fileId, input.bytes);
    return Promise.resolve({
      fileId,
      cloudPath: `garment-results/${input.ownerId}/${input.assetId}/result.jpg`,
      size: input.bytes.byteLength,
    });
  }
}

function createHarness(overrides: Partial<GarmentCloudBusinessHandlerDependencies> = {}) {
  const analyses = new MemoryGarmentAnalysisRepository();
  const assets = new MemoryGarmentAssetRepository();
  const tasks = new MemoryGenerationTaskRepository();
  const idempotency = new MemoryIdempotencyRepository();
  const quotas = new MemoryTrialQuotaRepository();
  const transactions = new MemoryTransactionRunner([analyses, assets, tasks, idempotency, quotas]);
  const storage = new MemoryAssetStorage();
  let id = 0;
  const persistence = { analyses, assets, tasks, idempotency, quotas, transactions };
  const dependencies: GarmentCloudBusinessHandlerDependencies = {
    getOpenId: () => "openid-user-1",
    isTrialMember: () => Promise.resolve(true),
    persistence,
    storage,
    providerMode: "fake" as const,
    now: () => now,
    createResourceId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    createRequestId: () => "request-1",
    trialDailyAnalysisLimit: 2,
    trialDailyGenerationLimit: 3,
    globalDailyAnalysisLimit: 10,
    globalDailyGenerationLimit: 10,
    assetRetentionHours: 72,
    ...overrides,
  };
  return {
    analyses,
    assets,
    tasks,
    idempotency,
    quotas,
    storage,
    persistence,
    dependencies,
    handler: createGarmentCloudBusinessHandler(dependencies),
  };
}

const brief = {
  mode: "quick-derivative" as const,
  preserveItems: ["格纹袖口"],
  changeRequest: "调整为短夹克",
  styleDirection: "复古工装",
  intensity: "medium" as const,
};

function realAnalysisFixture() {
  const unknownFact = {
    value: null,
    evidenceLevel: "unknown" as const,
    confidence: 0,
    evidence: "测试夹具不声明图片事实。",
  };
  const direction = (id: "direction-1" | "direction-2" | "direction-3", name: string) => ({
    id,
    name,
    summary: `${name}的可生产改款说明。`,
    changes: [
      { area: "silhouette" as const, instruction: "调整整体廓形比例", reason: "匹配改款目标" },
      { area: "sleeve" as const, instruction: "优化袖型结构", reason: "形成方向差异" },
    ],
    preserve: ["格纹袖口"],
    productionRisk: {
      level: "low" as const,
      newPatternPieces: [],
      newTrims: [],
      newOperations: [],
      fitOrStructureRisks: [],
      reason: "测试夹具风险较低。",
    },
    promptRequirements: {
      positive: ["复古工装"],
      hardConstraints: ["保留格纹袖口"],
      negative: ["文字", "水印"],
    },
  });
  return garmentAnalysisSchema.parse({
    schemaVersion: "garment-dna-v0.2",
    visualFacts: Object.fromEntries(garmentFactKeys.map((key) => [key, unknownFact])),
    userConstraints: {
      preserve: ["格纹袖口"],
      modify: ["调整为短夹克"],
      avoid: ["文字", "水印"],
    },
    conflictsOrQuestions: [],
    designDirections: [
      direction("direction-1", "商业平衡方向"),
      direction("direction-2", "结构探索方向"),
      direction("direction-3", "工艺强化方向"),
    ],
    recommendedDirectionId: "direction-1",
    recommendationReason: "测试夹具默认推荐第一方向。",
  });
}

function realProviders() {
  const analyze = vi.fn<GarmentAnalysisProvider["analyze"]>().mockResolvedValue({
    provider: "alibaba-qwen-vl",
    model: "qwen3.7-plus",
    providerRequestId: "analysis-request-1",
    durationMs: 1_200,
    attemptCount: 1,
    usage: {
      generatedImages: 0,
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      size: null,
    },
    analysis: realAnalysisFixture(),
  });
  const generateVariation = vi.fn<GarmentImageProvider["generateVariation"]>().mockResolvedValue({
    provider: "alibaba-qwen-image",
    model: "qwen-image-2.0-pro-2026-06-22",
    providerRequestId: "generation-request-1",
    durationMs: 2_400,
    assets: [{ bytes: Uint8Array.from([9, 8, 7, 6]), mimeType: "image/png" }],
    usage: {
      generatedImages: 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      size: "1024*1024",
    },
  });
  const analysisProvider: GarmentAnalysisProvider = {
    provider: "alibaba-qwen-vl",
    model: "qwen3.7-plus",
    configured: true,
    analyze,
  };
  const imageProvider: GarmentImageProvider = {
    provider: "alibaba-qwen-image",
    model: "qwen-image-2.0-pro-2026-06-22",
    configured: true,
    generateVariation,
  };
  return { analyze, generateVariation, analysisProvider, imageProvider };
}

function source(key: string) {
  return {
    idempotencyKey: key,
    cloudFileId: `cloud://env/garment-source-temp/${ownerId}/incoming/${key}.jpg`,
    fileName: "source.jpg",
    mimeType: "image/jpeg" as const,
    size: 3,
  };
}

describe("garment cloud business handler", () => {
  it("keeps the business path disabled unless an explicit provider mode is configured", async () => {
    const harness = createHarness({ providerMode: "disabled" });

    await expect(
      harness.handler({ action: "analyze-garment", ...source("analysis-key-1"), brief }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CLOUD_BACKEND_NOT_DEPLOYED", retryable: false },
    });
  });

  it("runs the verified Qwen providers with a persisted deterministic prompt", async () => {
    const providers = realProviders();
    const harness = createHarness({
      providerMode: "alibaba-qwen",
      analysisProvider: providers.analysisProvider,
      imageProvider: providers.imageProvider,
    });
    const analysisSource = source("real-analysis-key-1");
    harness.storage.files.set(analysisSource.cloudFileId, Uint8Array.from([1, 2, 3]));
    const analysis = await harness.handler({
      action: "analyze-garment",
      ...analysisSource,
      brief,
    });
    expect(analysis).toMatchObject({
      ok: true,
      data: { provider: "alibaba-qwen-vl", model: "qwen3.7-plus" },
    });
    if (!analysis.ok || !("analysisId" in analysis.data)) {
      throw new Error("expected real analysis to succeed");
    }

    const generationSource = source("real-generation-key-1");
    harness.storage.files.set(generationSource.cloudFileId, Uint8Array.from([1, 2, 3]));
    const confirmedBrief = {
      ...brief,
      preserveItems: [...brief.preserveItems, "门襟：中央金属拉链"],
    };
    const submitted = await harness.handler({
      action: "create-generation",
      ...generationSource,
      brief: confirmedBrief,
      analysisId: analysis.data.analysisId,
      directionId: "direction-2",
    });
    expect(submitted).toMatchObject({ ok: true, data: { status: "queued" } });
    if (!submitted.ok || !("jobId" in submitted.data)) {
      throw new Error("expected real generation submission to succeed");
    }
    const task = await harness.tasks.findById(ownerId, submitted.data.jobId, now);
    expect(task?.executionPayload).toMatchObject({
      version: "garment-generation-v2",
      providerMode: "alibaba-qwen",
      context: {
        promptVersion: "garment-analysis-v1",
        directionId: "direction-2",
        directionName: "结构探索方向",
        revisionInstructions: [],
      },
    });
    expect(JSON.stringify(task?.executionPayload)).toContain("禁止出现");
    expect(JSON.stringify(task?.executionPayload)).toContain("门襟：中央金属拉链");

    await expect(
      harness.handler({ action: "get-generation-job", jobId: submitted.data.jobId }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        status: "succeeded",
        provider: "alibaba-qwen-image",
        model: "qwen-image-2.0-pro-2026-06-22",
        durationMs: 2_400,
      },
    });
    expect(providers.analyze).toHaveBeenCalledTimes(1);
    expect(providers.generateVariation).toHaveBeenCalledTimes(1);
    expect(providers.generateVariation).toHaveBeenCalledWith(
      expect.objectContaining({
        promptVersion: "garment-analysis-v1",
        outputCount: 1,
      }),
    );

    const refinementSource = source("real-refinement-key-1");
    harness.storage.files.set(refinementSource.cloudFileId, Uint8Array.from([1, 2, 3]));
    const refined = await harness.handler({
      action: "create-refinement",
      ...refinementSource,
      parentJobId: submitted.data.jobId,
      instruction: "袖型再宽松一点",
    });
    expect(refined).toMatchObject({ ok: true, data: { status: "queued" } });
    if (!refined.ok || !("jobId" in refined.data)) {
      throw new Error("expected real refinement submission to succeed");
    }
    await expect(
      harness.handler({ action: "get-generation-job", jobId: refined.data.jobId }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        status: "succeeded",
        operation: "refine",
        parentJobId: submitted.data.jobId,
        revisionInstruction: "袖型再宽松一点",
      },
    });
    const refinementTask = await harness.tasks.findById(ownerId, refined.data.jobId, now);
    expect(refinementTask?.executionPayload).toMatchObject({
      context: {
        promptVersion: "garment-iteration-v1",
        revisionInstructions: ["袖型再宽松一点"],
      },
    });
    expect(providers.generateVariation).toHaveBeenCalledTimes(2);
    expect(providers.generateVariation.mock.calls[1]?.[0].prompt).toContain("袖型再宽松一点");
  });

  it("does not mark a started analysis provider failure as automatically retryable", async () => {
    const providers = realProviders();
    providers.analyze.mockRejectedValueOnce(
      new GarmentProviderError("PROVIDER_TIMEOUT", "服装视觉分析超时，请稍后重试。", {
        retryable: true,
      }),
    );
    const harness = createHarness({
      providerMode: "alibaba-qwen",
      analysisProvider: providers.analysisProvider,
      imageProvider: providers.imageProvider,
    });
    const request = { action: "analyze-garment" as const, ...source("real-timeout-key"), brief };
    harness.storage.files.set(request.cloudFileId, Uint8Array.from([1, 2, 3]));

    await expect(harness.handler(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "PROVIDER_TIMEOUT", retryable: false },
    });
    await expect(harness.handler(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_EXECUTION_IN_PROGRESS", retryable: true },
    });
    expect(providers.analyze).toHaveBeenCalledTimes(1);
  });

  it("persists an honest fake analysis and does not charge an idempotent retry twice", async () => {
    const harness = createHarness();
    const request = { action: "analyze-garment" as const, ...source("analysis-key-1"), brief };
    harness.storage.files.set(request.cloudFileId, Uint8Array.from([1, 2, 3]));

    const first = await harness.handler(request);
    const second = await harness.handler(request);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      data: {
        status: "succeeded",
        provider: "testing-fake",
        model: "fake-garment-analysis-v1",
        evidenceSummary: { accepted: 0, needsReview: 0, unknown: 16 },
      },
    });
    expect(JSON.stringify(first)).toContain("未调用视觉模型");
    await expect(harness.quotas.getUsage("user", ownerId, "analysis", "2026-08-27")).resolves.toBe(
      1,
    );
  });

  it("runs analysis, direction generation and status recovery across handler recreation", async () => {
    const harness = createHarness();
    const analysisSource = source("analysis-key-1");
    harness.storage.files.set(analysisSource.cloudFileId, Uint8Array.from([1, 2, 3]));
    const analysisResponse = await harness.handler({
      action: "analyze-garment",
      ...analysisSource,
      brief,
    });
    if (!analysisResponse.ok || !("analysisId" in analysisResponse.data)) {
      throw new Error("expected analysis to succeed");
    }

    const generationSource = source("generation-key-1");
    harness.storage.files.set(generationSource.cloudFileId, Uint8Array.from([1, 2, 3]));
    const generationRequest = {
      action: "create-generation",
      ...generationSource,
      brief,
      analysisId: analysisResponse.data.analysisId,
      directionId: "direction-2",
    } as const;
    const submitted = await harness.handler(generationRequest);
    expect(submitted).toMatchObject({ ok: true, data: { status: "queued" } });
    expect(harness.storage.saveCount).toBe(0);
    if (!submitted.ok || !("jobId" in submitted.data)) {
      throw new Error("expected generation submission to succeed");
    }

    const recreated = createGarmentCloudBusinessHandler(harness.dependencies);
    await expect(
      recreated({ action: "get-generation-job", jobId: submitted.data.jobId }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        jobId: submitted.data.jobId,
        status: "succeeded",
        provider: "testing-fake",
        strategy: "analyzed",
        directionId: "direction-2",
        directionName: "结构探索方向",
      },
    });
    await expect(recreated(generationRequest)).resolves.toMatchObject({
      ok: true,
      data: { jobId: submitted.data.jobId, status: "succeeded" },
    });
    expect(harness.storage.saveCount).toBe(1);
    await expect(
      harness.quotas.getUsage("user", ownerId, "generation", "2026-08-27"),
    ).resolves.toBe(1);
  });

  it("creates a refinement linked to the persisted parent result", async () => {
    const harness = createHarness();
    const generationSource = source("generation-key-1");
    harness.storage.files.set(generationSource.cloudFileId, Uint8Array.from([1, 2, 3]));
    const submitted = await harness.handler({
      action: "create-generation",
      ...generationSource,
      brief,
    });
    if (!submitted.ok || !("jobId" in submitted.data)) {
      throw new Error("expected generation submission to succeed");
    }
    await expect(
      harness.handler({ action: "get-generation-job", jobId: submitted.data.jobId }),
    ).resolves.toMatchObject({ ok: true, data: { status: "succeeded" } });

    const refinementSource = source("refinement-key-1");
    harness.storage.files.set(refinementSource.cloudFileId, Uint8Array.from([1, 2, 3]));
    const refined = await harness.handler({
      action: "create-refinement",
      ...refinementSource,
      parentJobId: submitted.data.jobId,
      instruction: "袖型再宽松一点",
    });
    expect(refined).toMatchObject({ ok: true, data: { status: "queued" } });
    if (!refined.ok || !("jobId" in refined.data)) {
      throw new Error("expected refinement submission to succeed");
    }
    await expect(
      harness.handler({ action: "get-generation-job", jobId: refined.data.jobId }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        status: "succeeded",
        operation: "refine",
        parentJobId: submitted.data.jobId,
        revisionInstruction: "袖型再宽松一点",
      },
    });
  });

  it("serializes concurrent idempotent submissions and poll-driven execution", async () => {
    const harness = createHarness();
    const generationSource = source("generation-key-1");
    harness.storage.files.set(generationSource.cloudFileId, Uint8Array.from([1, 2, 3]));
    const request = {
      action: "create-generation",
      ...generationSource,
      brief,
    } as const;

    const [first, second] = await Promise.all([harness.handler(request), harness.handler(request)]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(harness.storage.saveCount).toBe(0);
    if (!first.ok || !("jobId" in first.data) || !second.ok || !("jobId" in second.data)) {
      throw new Error("expected both submissions to return a job");
    }
    expect(first.data.jobId).toBe(second.data.jobId);

    await Promise.all([
      harness.handler({ action: "get-generation-job", jobId: first.data.jobId }),
      harness.handler({ action: "get-generation-job", jobId: first.data.jobId }),
    ]);
    await expect(
      harness.handler({ action: "get-generation-job", jobId: first.data.jobId }),
    ).resolves.toMatchObject({ ok: true, data: { status: "succeeded" } });
    expect(harness.storage.saveCount).toBe(1);
    await expect(
      harness.quotas.getUsage("user", ownerId, "generation", "2026-08-27"),
    ).resolves.toBe(1);
  });

  it("keeps a persisted job generating while a delayed worker is still running", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ fakeGenerationDelayMs: 8_000 });
      const generationSource = source("generation-key-delayed");
      harness.storage.files.set(generationSource.cloudFileId, Uint8Array.from([1, 2, 3]));
      const submitted = await harness.handler({
        action: "create-generation",
        ...generationSource,
        brief,
      });
      if (!submitted.ok || !("jobId" in submitted.data)) {
        throw new Error("expected generation submission to succeed");
      }
      expect(submitted.data.status).toBe("queued");

      const running = harness.handler({
        action: "get-generation-job",
        jobId: submitted.data.jobId,
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(
        harness.tasks.findById(ownerId, submitted.data.jobId, now),
      ).resolves.toMatchObject({ status: { status: "generating" } });

      await vi.advanceTimersByTimeAsync(8_000);
      await expect(running).resolves.toMatchObject({
        ok: true,
        data: { status: "succeeded" },
      });
      expect(harness.storage.saveCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns an expired post-provider lease into a stable failure while polling", async () => {
    let currentTime = now;
    const harness = createHarness({ now: () => currentTime });
    const jobId = "00000000-0000-4000-8000-000000000099";
    const admitted = await new GenerationTaskAdmissionService(harness.persistence).admit({
      ownerId,
      action: "generation",
      idempotencyKey: "generation-key-1",
      requestFingerprint: "fingerprint-a",
      jobId,
      statusUrl: `wechat-cloud://generation-jobs/${jobId}`,
      createdAt: now,
      expiresAt: "2026-09-27T12:00:00.000Z",
      quotaReservations: [],
    });
    const execution = new GenerationTaskExecutionService(harness.persistence);
    await execution.claim({
      ownerId,
      jobId,
      leaseId: "lease-1",
      now,
      leaseExpiresAt: "2026-08-27T12:01:00.000Z",
      interruptedError: {
        code: "GENERATION_EXECUTION_INTERRUPTED",
        message: "interrupted",
        requestId: "request-1",
        retryable: false,
      },
    });
    await execution.markProviderCallStarted({
      ownerId,
      jobId,
      leaseId: "lease-1",
      now: "2026-08-27T12:00:10.000Z",
    });
    expect(admitted.task.status.status).toBe("queued");

    currentTime = "2026-08-27T12:02:00.000Z";
    await expect(harness.handler({ action: "get-generation-job", jobId })).resolves.toMatchObject({
      ok: true,
      data: {
        status: "failed",
        error: { code: "GENERATION_EXECUTION_INTERRUPTED", retryable: false },
      },
    });
    expect(harness.storage.saveCount).toBe(0);
  });
});
