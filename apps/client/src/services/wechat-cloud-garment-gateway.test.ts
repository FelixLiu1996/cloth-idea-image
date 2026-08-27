import type { GarmentAnalysis, GenerationApiResponse } from "@cloth-idea/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tarojs/taro", () => ({
  default: {
    cloud: { callFunction: vi.fn(), uploadFile: vi.fn() },
    getStorageSync: vi.fn(),
    setStorageSync: vi.fn(),
    removeStorageSync: vi.fn(),
  },
}));

import type { PendingGenerationJobStore } from "../platform/pending-generation-platform";
import {
  WechatCloudGarmentGateway,
  type WechatCloudGarmentClient,
} from "./wechat-cloud-garment-gateway";

function fact() {
  return {
    value: null,
    evidenceLevel: "unknown" as const,
    confidence: 0,
    evidence: "Fake Provider 测试证据",
  };
}

const analysis: GarmentAnalysis = {
  schemaVersion: "garment-dna-v0.2",
  visualFacts: {
    category: fact(),
    silhouette: fact(),
    length: fact(),
    shoulder: fact(),
    collar: fact(),
    closure: fact(),
    sleeve: fact(),
    cuff: fact(),
    pockets: fact(),
    frontPanels: fact(),
    backPanels: fact(),
    fabric: fact(),
    color: fact(),
    trims: fact(),
    craftsmanship: fact(),
    presentation: fact(),
  },
  userConstraints: { preserve: [], modify: ["调整廓形"], avoid: ["额外水印"] },
  conflictsOrQuestions: ["Fake Provider 未调用视觉模型"],
  designDirections: [1, 2, 3].map((number) => ({
    id: `direction-${number}` as "direction-1" | "direction-2" | "direction-3",
    name: `方向${number}`,
    summary: "链路验证方向",
    changes: [
      { area: "silhouette" as const, instruction: "调整整体廓形", reason: "验证链路" },
      { area: "craftsmanship" as const, instruction: "调整工艺语言", reason: "验证链路" },
    ],
    preserve: [],
    productionRisk: {
      level: "low" as const,
      newPatternPieces: [],
      newTrims: [],
      newOperations: [],
      fitOrStructureRisks: [],
      reason: "仅用于测试",
    },
    promptRequirements: {
      positive: ["真实商品图"],
      hardConstraints: ["保持主体完整"],
      negative: ["额外水印"],
    },
  })),
  recommendedDirectionId: "direction-1",
  recommendationReason: "默认测试推荐方向",
};

const capabilities = {
  transport: "wechat-cloud",
  authorized: true,
  viewerFingerprint: "abcdef1234567890",
  trialAccessRequired: false,
  trialDailyAnalysisLimit: 10,
  trialDailyGenerationLimit: 15,
  assetRetentionHours: 72,
} as const;

const result: GenerationApiResponse = {
  jobId: "00000000-0000-4000-8000-000000000001",
  status: "succeeded",
  provider: "testing-fake",
  model: "fake-image-copy-v1",
  resultUrl: "cloud://env/garment-results/viewer/result.jpg",
  summary: "Fake Provider 链路验证",
  durationMs: 0,
  strategy: "analyzed",
  directionId: "direction-1",
  directionName: "方向1",
  operation: "initial",
  parentJobId: null,
  revisionInstruction: null,
  createdAt: "2026-08-27T12:00:00.000Z",
};

function input() {
  return {
    imagePath: "/tmp/source.png",
    imageSize: 120,
    mode: "quick-derivative" as const,
    preserveItems: "格纹袖口，深色面料",
    changeRequest: "调整为短夹克",
    styleDirection: "复古工装",
    intensity: "medium" as const,
  };
}

function memoryPending(initial: string | null = null): PendingGenerationJobStore & {
  value: string | null;
} {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(jobId) {
      this.value = jobId;
    },
    clear() {
      this.value = null;
    },
  };
}

describe("WeChat cloud garment gateway", () => {
  it("loads capabilities through the isolated garment cloud function", async () => {
    const callFunction = vi.fn().mockResolvedValue({ result: { ok: true, data: capabilities } });
    const gateway = new WechatCloudGarmentGateway({
      callFunction,
      uploadFile: vi.fn(),
    } as WechatCloudGarmentClient);

    await expect(gateway.getTrialCapabilities()).resolves.toEqual({
      trialAccessRequired: false,
      trialDailyAnalysisLimit: 10,
      trialDailyGenerationLimit: 15,
      assetRetentionHours: 72,
    });
    expect(callFunction).toHaveBeenCalledWith({
      name: "garment-api",
      data: { action: "get-capabilities" },
    });
  });

  it("uploads the source and parses a structured fake analysis", async () => {
    const uploadFile = vi.fn().mockResolvedValue({ fileID: "cloud://env/source.png" });
    const callFunction = vi.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        result:
          data.action === "get-capabilities"
            ? { ok: true, data: capabilities }
            : {
                ok: true,
                data: {
                  analysisId: "00000000-0000-4000-8000-000000000001",
                  status: "succeeded",
                  provider: "testing-fake",
                  model: "fake-garment-analysis-v1",
                  durationMs: 0,
                  analysis,
                  evidenceSummary: { accepted: 0, needsReview: 0, unknown: 16 },
                },
              },
      }),
    );
    const gateway = new WechatCloudGarmentGateway({
      callFunction,
      uploadFile,
    } as WechatCloudGarmentClient);

    await expect(gateway.analyzeGarment(input())).resolves.toMatchObject({
      provider: "testing-fake",
      analysisId: "00000000-0000-4000-8000-000000000001",
    });
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudPath: expect.stringMatching(
          /^garment-source-temp\/abcdef1234567890\/incoming\/.+\.png$/,
        ),
        filePath: "/tmp/source.png",
      }),
    );
    expect(callFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "analyze-garment",
          size: 120,
          brief: expect.objectContaining({ preserveItems: ["格纹袖口", "深色面料"] }),
        }),
      }),
    );
  });

  it("rejects an inconsistent analysis without relying on a client-side Zod runtime", async () => {
    const uploadFile = vi.fn().mockResolvedValue({ fileID: "cloud://env/source.png" });
    const callFunction = vi.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        result:
          data.action === "get-capabilities"
            ? { ok: true, data: capabilities }
            : {
                ok: true,
                data: {
                  analysisId: "00000000-0000-4000-8000-000000000001",
                  status: "succeeded",
                  provider: "testing-fake",
                  model: "fake-garment-analysis-v1",
                  durationMs: 0,
                  analysis: {
                    ...analysis,
                    designDirections: [
                      analysis.designDirections[0],
                      analysis.designDirections[0],
                      analysis.designDirections[2],
                    ],
                  },
                  evidenceSummary: { accepted: 0, needsReview: 0, unknown: 16 },
                },
              },
      }),
    );
    const gateway = new WechatCloudGarmentGateway({
      callFunction,
      uploadFile,
    } as WechatCloudGarmentClient);

    await expect(gateway.analyzeGarment(input())).rejects.toMatchObject({
      code: "BAD_CLOUD_RESPONSE",
    });
  });

  it("polls a queued task and keeps its recovery marker until a new page acknowledges it", async () => {
    const pending = memoryPending();
    const uploadFile = vi.fn().mockResolvedValue({ fileID: "cloud://env/source.png" });
    const callFunction = vi.fn().mockImplementation(({ data }) => {
      if (data.action === "get-capabilities") {
        return Promise.resolve({ result: { ok: true, data: capabilities } });
      }
      if (data.action === "create-generation") {
        return Promise.resolve({
          result: {
            ok: true,
            data: {
              jobId: result.jobId,
              status: "queued",
              statusUrl: `wechat-cloud://generation-jobs/${result.jobId}`,
              createdAt: result.createdAt,
              updatedAt: result.createdAt,
            },
          },
        });
      }
      return Promise.resolve({ result: { ok: true, data: result } });
    });
    const gateway = new WechatCloudGarmentGateway(
      { callFunction, uploadFile } as WechatCloudGarmentClient,
      pending,
    );

    await expect(
      gateway.createGeneration({
        ...input(),
        analysisId: "analysis-1",
        directionId: "direction-1",
      }),
    ).resolves.toEqual(result);
    expect(pending.value).toBe(result.jobId);
    expect(callFunction).toHaveBeenCalledWith({
      name: "garment-api",
      data: { action: "get-generation-job", jobId: result.jobId },
    });
  });

  it("restores a persisted task after the gateway is recreated", async () => {
    const pending = memoryPending(result.jobId);
    const callFunction = vi.fn().mockResolvedValue({ result: { ok: true, data: result } });
    const recreatedGateway = new WechatCloudGarmentGateway(
      { callFunction, uploadFile: vi.fn() } as WechatCloudGarmentClient,
      pending,
    );

    await expect(recreatedGateway.restorePendingGeneration()).resolves.toEqual(result);
    expect(pending.value).toBeNull();
  });

  it("does not let an older restored task clear a newer pending job", async () => {
    const pending = memoryPending(result.jobId);
    const newerJobId = "00000000-0000-4000-8000-000000000002";
    const callFunction = vi.fn().mockImplementation(() => {
      pending.write(newerJobId);
      return Promise.resolve({ result: { ok: true, data: result } });
    });
    const gateway = new WechatCloudGarmentGateway(
      { callFunction, uploadFile: vi.fn() } as WechatCloudGarmentClient,
      pending,
    );

    await expect(gateway.restorePendingGeneration()).resolves.toEqual(result);
    expect(pending.value).toBe(newerJobId);
  });

  it("maps stable cloud errors without exposing raw cloud details", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: false,
        error: {
          code: "AUTH_TRIAL_MEMBER_REQUIRED",
          message: "当前微信账号尚未加入体验名单。",
          requestId: "request-1",
          retryable: false,
        },
      },
    });
    const gateway = new WechatCloudGarmentGateway({
      callFunction,
      uploadFile: vi.fn(),
    } as WechatCloudGarmentClient);

    await expect(gateway.getTrialCapabilities()).rejects.toMatchObject({
      code: "AUTH_TRIAL_MEMBER_REQUIRED",
      retryable: false,
    });
  });

  it("normalizes cloud invocation failures", async () => {
    const callFunction = vi.fn().mockRejectedValue(new Error("internal cloud details"));
    const gateway = new WechatCloudGarmentGateway({
      callFunction,
      uploadFile: vi.fn(),
    } as WechatCloudGarmentClient);

    await expect(gateway.getTrialCapabilities()).rejects.toMatchObject({
      code: "CLOUD_FUNCTION_UNAVAILABLE",
      retryable: true,
      message: "无法连接微信云端服务，请稍后重试。",
    });
  });
});
