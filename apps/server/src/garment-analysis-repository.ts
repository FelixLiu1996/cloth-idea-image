import { createHash, randomUUID } from "node:crypto";

import {
  applyEvidenceGate,
  type GarmentAnalysisApiResponse,
  type GarmentAnalysisProviderResult,
  type SourceImageInput,
} from "@cloth-idea/domain";

interface StoredGarmentAnalysis {
  readonly response: GarmentAnalysisApiResponse;
  readonly sourceImageSha256: string;
  readonly expiresAt: number;
}

function sourceImageSha256(sourceImage: SourceImageInput): string {
  return createHash("sha256").update(sourceImage.bytes).digest("hex");
}

export class GarmentAnalysisRepository {
  private readonly analyses = new Map<string, StoredGarmentAnalysis>();
  private readonly executionsByIdempotencyKey = new Map<
    string,
    Promise<GarmentAnalysisApiResponse>
  >();

  constructor(private readonly ttlMs = 60 * 60 * 1_000) {}

  save(
    sourceImage: SourceImageInput,
    providerResult: GarmentAnalysisProviderResult,
  ): GarmentAnalysisApiResponse {
    const analysisId = randomUUID();
    const evidence = applyEvidenceGate(providerResult.analysis.visualFacts);
    const response: GarmentAnalysisApiResponse = {
      analysisId,
      status: "succeeded",
      provider: providerResult.provider,
      model: providerResult.model,
      durationMs: providerResult.durationMs,
      analysis: providerResult.analysis,
      evidenceSummary: {
        accepted: evidence.accepted.length,
        needsReview: evidence.needsReview.length,
        unknown: evidence.unknown.length,
      },
    };
    this.analyses.set(analysisId, {
      response,
      sourceImageSha256: sourceImageSha256(sourceImage),
      expiresAt: Date.now() + this.ttlMs,
    });
    return response;
  }

  get(analysisId: string): GarmentAnalysisApiResponse | null {
    const record = this.getRecord(analysisId);
    return record?.response ?? null;
  }

  matchesSourceImage(analysisId: string, sourceImage: SourceImageInput): boolean {
    const record = this.getRecord(analysisId);
    return record?.sourceImageSha256 === sourceImageSha256(sourceImage);
  }

  async executeOnce(
    key: string | undefined,
    onAccepted: () => void,
    operation: () => Promise<GarmentAnalysisApiResponse>,
  ): Promise<{ result: GarmentAnalysisApiResponse; reused: boolean }> {
    if (!key) {
      onAccepted();
      return { result: await operation(), reused: false };
    }

    const existingExecution = this.executionsByIdempotencyKey.get(key);
    if (existingExecution) {
      return { result: await existingExecution, reused: true };
    }

    onAccepted();
    const execution = operation();
    this.executionsByIdempotencyKey.set(key, execution);
    try {
      return { result: await execution, reused: false };
    } catch (error) {
      if (this.executionsByIdempotencyKey.get(key) === execution) {
        this.executionsByIdempotencyKey.delete(key);
      }
      throw error;
    }
  }

  private getRecord(analysisId: string): StoredGarmentAnalysis | null {
    const record = this.analyses.get(analysisId);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= Date.now()) {
      this.analyses.delete(analysisId);
      return null;
    }
    return record;
  }
}
