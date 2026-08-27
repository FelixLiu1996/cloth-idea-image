import type { GarmentAnalysisApiResponse } from "@cloth-idea/domain";
import { describe, expect, it } from "vitest";

import {
  MemoryGarmentAnalysisRepository,
  MemoryGarmentAssetRepository,
  MemoryTrialQuotaRepository,
} from "./memory-repositories";

const beforeExpiry = "2026-08-27T10:00:00.000Z";
const expiresAt = "2026-08-27T11:00:00.000Z";
const afterExpiry = "2026-08-27T12:00:00.000Z";

function analysisResponse(): GarmentAnalysisApiResponse {
  return {
    analysisId: "00000000-0000-4000-8000-000000000001",
    status: "succeeded",
    provider: "alibaba-qwen-vl",
    model: "fake-analysis",
    durationMs: 1,
    analysis: {
      schemaVersion: "garment-dna-v0.2",
      visualFacts: Object.fromEntries(
        [
          "category",
          "silhouette",
          "length",
          "shoulder",
          "collar",
          "closure",
          "sleeve",
          "cuff",
          "pockets",
          "frontPanels",
          "backPanels",
          "fabric",
          "color",
          "trims",
          "craftsmanship",
          "presentation",
        ].map((key) => [
          key,
          {
            value: null,
            evidenceLevel: "unknown",
            confidence: 0,
            evidence: "测试占位",
          },
        ]),
      ) as GarmentAnalysisApiResponse["analysis"]["visualFacts"],
      userConstraints: { preserve: [], modify: [], avoid: [] },
      conflictsOrQuestions: [],
      designDirections: [1, 2, 3].map((index) => ({
        id: `direction-${index}` as "direction-1" | "direction-2" | "direction-3",
        name: `方向${index}`,
        summary: "测试方向",
        changes: [
          { area: "silhouette", instruction: "调整廓形", reason: "用于测试" },
          { area: "pockets", instruction: "调整口袋", reason: "用于测试" },
        ],
        preserve: [],
        productionRisk: {
          level: "low",
          newPatternPieces: [],
          newTrims: [],
          newOperations: [],
          fitOrStructureRisks: [],
          reason: "测试风险",
        },
        promptRequirements: { positive: [], hardConstraints: [], negative: [] },
      })),
      recommendedDirectionId: "direction-1",
      recommendationReason: "用于测试",
    },
    evidenceSummary: { accepted: 0, needsReview: 0, unknown: 16 },
  };
}

describe("memory application repositories", () => {
  it("isolates analyses by owner and expires them", async () => {
    const repository = new MemoryGarmentAnalysisRepository();
    const response = analysisResponse();
    await repository.save({
      analysisId: response.analysisId,
      ownerId: "viewer-a",
      response,
      sourceImageSha256: "source-hash",
      expiresAt,
    });

    await expect(
      repository.findById("viewer-b", response.analysisId, beforeExpiry),
    ).resolves.toBeNull();
    await expect(
      repository.findById("viewer-a", response.analysisId, beforeExpiry),
    ).resolves.toMatchObject({ sourceImageSha256: "source-hash" });
    await expect(
      repository.findById("viewer-a", response.analysisId, afterExpiry),
    ).resolves.toBeNull();
  });

  it("returns expired asset records for physical storage cleanup", async () => {
    const repository = new MemoryGarmentAssetRepository();
    await repository.save({
      assetId: "asset-1",
      ownerId: "viewer-a",
      kind: "source",
      fileId: "cloud://environment/source.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      createdAt: beforeExpiry,
      expiresAt,
    });

    await expect(repository.findById("viewer-b", "asset-1", beforeExpiry)).resolves.toBeNull();
    await expect(repository.deleteExpired(afterExpiry)).resolves.toEqual([
      expect.objectContaining({ assetId: "asset-1", fileId: "cloud://environment/source.jpg" }),
    ]);
    await expect(repository.findById("viewer-a", "asset-1", afterExpiry)).resolves.toBeNull();
  });

  it("checks duplicate quota dimensions as one atomic reservation", async () => {
    const repository = new MemoryTrialQuotaRepository();

    await expect(
      repository.reserveMany([
        {
          scope: "user",
          subjectId: "viewer-a",
          kind: "generation",
          day: "2026-08-27",
          amount: 1,
          limit: 1,
        },
        {
          scope: "user",
          subjectId: "viewer-a",
          kind: "generation",
          day: "2026-08-27",
          amount: 1,
          limit: 1,
        },
      ]),
    ).resolves.toMatchObject({ allowed: false });
    await expect(repository.getUsage("user", "viewer-a", "generation", "2026-08-27")).resolves.toBe(
      0,
    );
  });
});
