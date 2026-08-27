import { createHash } from "node:crypto";

import {
  MemoryGarmentAnalysisRepository,
  MemoryGarmentAssetRepository,
  MemoryGenerationTaskRepository,
  MemoryIdempotencyRepository,
  MemoryTransactionRunner,
  MemoryTrialQuotaRepository,
} from "@cloth-idea/application";
import { describe, expect, it } from "vitest";

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
    fakeProviderEnabled: true,
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
  it("keeps the business path disabled unless the explicit fake-provider flag is set", async () => {
    const harness = createHarness({ fakeProviderEnabled: false });

    await expect(
      harness.handler({ action: "analyze-garment", ...source("analysis-key-1"), brief }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CLOUD_BACKEND_NOT_DEPLOYED", retryable: false },
    });
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
    harness.storage.files.set(generationSource.cloudFileId, Uint8Array.from([4, 5, 6]));
    const generationRequest = {
      action: "create-generation",
      ...generationSource,
      brief,
      analysisId: analysisResponse.data.analysisId,
      directionId: "direction-2",
    } as const;
    const submitted = await harness.handler(generationRequest);
    expect(submitted).toMatchObject({ ok: true, data: { status: "queued" } });
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

    const refinementSource = source("refinement-key-1");
    harness.storage.files.set(refinementSource.cloudFileId, Uint8Array.from([4, 5, 6]));
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
});
