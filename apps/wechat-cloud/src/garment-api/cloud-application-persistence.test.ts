import {
  GenerationTaskAdmissionService,
  GenerationTaskExecutionService,
  IdempotencyConflictError,
  TrialQuotaExceededError,
  type AdmitGenerationTaskInput,
} from "@cloth-idea/application";
import type { GarmentAnalysisApiResponse } from "@cloth-idea/domain";
import { describe, expect, it } from "vitest";

import {
  applicationCollectionNames,
  createWechatCloudApplicationPersistence,
  type WechatCloudCollection,
  type WechatCloudDatabase,
  type WechatCloudDatabaseContext,
  type WechatCloudDocumentReference,
  type WechatCloudQuery,
} from "./cloud-application-persistence";

interface DateComparisonCondition {
  readonly operation: "lte" | "gt";
  readonly value: string;
}

function isDateComparisonCondition(value: unknown): value is DateComparisonCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    "operation" in value &&
    (value.operation === "lte" || value.operation === "gt") &&
    "value" in value &&
    typeof value.value === "string"
  );
}

type Documents = Map<string, Map<string, Record<string, unknown>>>;

function cloneDocuments(documents: Documents): Documents {
  return new Map(
    [...documents].map(([collectionName, collection]) => [
      collectionName,
      new Map(
        [...collection].map(([id, document]) => [
          id,
          structuredClone(document) as Record<string, unknown>,
        ]),
      ),
    ]),
  );
}

class MemoryDocumentReference implements WechatCloudDocumentReference {
  constructor(
    private readonly documents: Documents,
    private readonly collectionName: string,
    private readonly id: string,
  ) {}

  async get(): Promise<{ readonly data?: unknown }> {
    const document = this.documents.get(this.collectionName)?.get(this.id);
    if (!document) {
      throw { code: "DATABASE_DOCUMENT_NOT_FOUND" };
    }
    return { data: { _id: this.id, ...structuredClone(document) } };
  }

  async set(input: { readonly data: object }): Promise<unknown> {
    let collection = this.documents.get(this.collectionName);
    if (!collection) {
      collection = new Map();
      this.documents.set(this.collectionName, collection);
    }
    collection.set(this.id, structuredClone(input.data) as Record<string, unknown>);
    return { updated: 1 };
  }

  async remove(): Promise<unknown> {
    this.documents.get(this.collectionName)?.delete(this.id);
    return { deleted: 1 };
  }
}

class MemoryCollection implements WechatCloudCollection {
  constructor(
    private readonly documents: Documents,
    private readonly collectionName: string,
    private readonly condition: Readonly<Record<string, unknown>> = {},
    private readonly maximum = Number.POSITIVE_INFINITY,
  ) {}

  doc(id: string): WechatCloudDocumentReference {
    return new MemoryDocumentReference(this.documents, this.collectionName, id);
  }

  where(condition: Readonly<Record<string, unknown>>): WechatCloudQuery {
    return new MemoryCollection(this.documents, this.collectionName, condition, this.maximum);
  }

  limit(count: number): WechatCloudQuery {
    return new MemoryCollection(this.documents, this.collectionName, this.condition, count);
  }

  async get(): Promise<{ readonly data?: unknown }> {
    const documents = [...(this.documents.get(this.collectionName) ?? new Map())]
      .filter(([, document]) =>
        Object.entries(this.condition).every(([field, expected]) => {
          const actual = document[field];
          return isDateComparisonCondition(expected)
            ? typeof actual === "string" &&
                (expected.operation === "lte" ? actual <= expected.value : actual > expected.value)
            : actual === expected;
        }),
      )
      .slice(0, this.maximum)
      .map(([id, document]) => ({ _id: id, ...structuredClone(document) }));
    return { data: documents };
  }
}

class MemoryDatabaseContext implements WechatCloudDatabaseContext {
  constructor(protected documents: Documents) {}

  collection(name: string): WechatCloudCollection {
    return new MemoryCollection(this.documents, name);
  }
}

class MemoryWechatCloudDatabase extends MemoryDatabaseContext implements WechatCloudDatabase {
  readonly command = {
    lte: (value: string): DateComparisonCondition => ({ operation: "lte", value }),
    gt: (value: string): DateComparisonCondition => ({ operation: "gt", value }),
  };
  private pending: Promise<void> = Promise.resolve();

  constructor() {
    super(new Map());
  }

  async runTransaction<T>(
    operation: (transaction: WechatCloudDatabaseContext) => Promise<T>,
  ): Promise<T> {
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.pending;
    this.pending = previous.then(() => turn);
    await previous;

    const transactionDocuments = cloneDocuments(this.documents);
    try {
      const result = await operation(new MemoryDatabaseContext(transactionDocuments));
      this.documents = transactionDocuments;
      return result;
    } finally {
      release?.();
    }
  }

  count(collectionName: string): number {
    return this.documents.get(collectionName)?.size ?? 0;
  }
}

const createdAt = "2026-08-27T10:00:00.000Z";
const expiresAt = "2026-09-27T10:00:00.000Z";

function analysisResponse(): GarmentAnalysisApiResponse {
  return {
    analysisId: "00000000-0000-4000-8000-000000000099",
    status: "succeeded",
    provider: "alibaba-qwen-vl",
    model: "fake-analysis",
    durationMs: 10,
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

function input(overrides: Partial<AdmitGenerationTaskInput> = {}): AdmitGenerationTaskInput {
  return {
    ownerId: "viewer-a",
    action: "generation",
    idempotencyKey: "key-a",
    requestFingerprint: "fingerprint-a",
    jobId: "00000000-0000-4000-8000-000000000001",
    statusUrl: "/api/v1/generations/00000000-0000-4000-8000-000000000001",
    createdAt,
    expiresAt,
    quotaReservations: [
      {
        scope: "user",
        subjectId: "viewer-a",
        kind: "generation",
        day: "2026-08-27",
        amount: 1,
        limit: 2,
      },
      {
        scope: "global",
        subjectId: "trial",
        kind: "generation",
        day: "2026-08-27",
        amount: 1,
        limit: 10,
      },
    ],
    ...overrides,
  };
}

function createService(database: WechatCloudDatabase) {
  const persistence = createWechatCloudApplicationPersistence(database);
  return {
    persistence,
    service: new GenerationTaskAdmissionService(persistence),
  };
}

describe("WeChat Cloud application persistence", () => {
  it("isolates analyses by owner and restores them across adapter instances until expiry", async () => {
    const database = new MemoryWechatCloudDatabase();
    const first = createService(database);
    const response = analysisResponse();
    await first.persistence.analyses.save({
      analysisId: response.analysisId,
      ownerId: "viewer-a",
      response,
      sourceImageSha256: "source-hash",
      expiresAt,
    });

    const recreated = createService(database);
    await expect(
      recreated.persistence.analyses.findById("viewer-b", response.analysisId, createdAt),
    ).resolves.toBeNull();
    await expect(
      recreated.persistence.analyses.findById("viewer-a", response.analysisId, createdAt),
    ).resolves.toMatchObject({ sourceImageSha256: "source-hash" });
    await expect(
      recreated.persistence.analyses.findById(
        "viewer-a",
        response.analysisId,
        "2026-10-01T00:00:00.000Z",
      ),
    ).resolves.toBeNull();
    await expect(recreated.persistence.analyses.deleteExpired(expiresAt)).resolves.toBe(1);
  });

  it("isolates asset metadata and supports active and expiry-driven cleanup", async () => {
    const database = new MemoryWechatCloudDatabase();
    const first = createService(database);
    await first.persistence.assets.save({
      assetId: "source-1",
      ownerId: "viewer-a",
      kind: "source",
      fileId: "cloud://test-environment/source-1.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      createdAt,
      expiresAt,
    });
    await first.persistence.assets.save({
      assetId: "result-1",
      ownerId: "viewer-a",
      kind: "result",
      fileId: "cloud://test-environment/result-1.png",
      mimeType: "image/png",
      size: 2048,
      createdAt,
      expiresAt: "2026-12-01T00:00:00.000Z",
    });

    const recreated = createService(database);
    await expect(
      recreated.persistence.assets.findById("viewer-b", "source-1", createdAt),
    ).resolves.toBeNull();
    await expect(
      recreated.persistence.assets.findById("viewer-a", "source-1", createdAt),
    ).resolves.toMatchObject({ fileId: "cloud://test-environment/source-1.jpg" });
    await expect(recreated.persistence.assets.findExpired(expiresAt, 100)).resolves.toEqual([
      expect.objectContaining({ assetId: "source-1", ownerId: "viewer-a" }),
    ]);
    await expect(
      recreated.persistence.assets.hasActiveFileReference(
        "cloud://test-environment/result-1.png",
        expiresAt,
      ),
    ).resolves.toBe(true);
    await expect(recreated.persistence.assets.delete("viewer-a", "source-1")).resolves.toBe(true);
    await expect(recreated.persistence.assets.delete("viewer-b", "result-1")).resolves.toBe(false);
    await expect(recreated.persistence.assets.delete("viewer-a", "result-1")).resolves.toBe(true);
    expect(database.count(applicationCollectionNames.assets)).toBe(0);
  });

  it("keeps one task and one quota charge across adapter recreation and concurrent retries", async () => {
    const database = new MemoryWechatCloudDatabase();
    const first = createService(database);

    const [created, reused] = await Promise.all([
      first.service.admit(input()),
      first.service.admit(input()),
    ]);
    const recreated = createService(database);
    const afterRecreation = await recreated.service.admit(input());

    expect([created.reused, reused.reused].sort()).toEqual([false, true]);
    expect(afterRecreation.reused).toBe(true);
    expect(afterRecreation.task.jobId).toBe(input().jobId);
    await expect(
      recreated.persistence.quotas.getUsage("user", "viewer-a", "generation", "2026-08-27"),
    ).resolves.toBe(1);
    expect(database.count(applicationCollectionNames.generationTasks)).toBe(1);
    expect(database.count(applicationCollectionNames.idempotency)).toBe(1);
    expect(database.count(applicationCollectionNames.trialUsage)).toBe(2);
  });

  it("rejects an idempotency-key conflict without consuming more quota", async () => {
    const database = new MemoryWechatCloudDatabase();
    const harness = createService(database);
    await harness.service.admit(input());

    await expect(
      harness.service.admit(input({ requestFingerprint: "fingerprint-b" })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      harness.persistence.quotas.getUsage("user", "viewer-a", "generation", "2026-08-27"),
    ).resolves.toBe(1);
  });

  it("rolls back quota, task and idempotency writes when the limit is exceeded", async () => {
    const database = new MemoryWechatCloudDatabase();
    const harness = createService(database);
    const rejected = input({
      quotaReservations: [
        {
          scope: "user",
          subjectId: "viewer-a",
          kind: "generation",
          day: "2026-08-27",
          amount: 2,
          limit: 1,
        },
      ],
    });

    await expect(harness.service.admit(rejected)).rejects.toBeInstanceOf(TrialQuotaExceededError);
    await expect(
      harness.persistence.tasks.findById(rejected.ownerId, rejected.jobId, createdAt),
    ).resolves.toBeNull();
    expect(database.count(applicationCollectionNames.generationTasks)).toBe(0);
    expect(database.count(applicationCollectionNames.idempotency)).toBe(0);
    expect(database.count(applicationCollectionNames.trialUsage)).toBe(0);
  });

  it("persists task status updates and deletes expired task/idempotency records", async () => {
    const database = new MemoryWechatCloudDatabase();
    const first = createService(database);
    const admitted = await first.service.admit(input());
    const updatedAt = "2026-08-27T10:00:01.000Z";

    await new GenerationTaskExecutionService(first.persistence).claim({
      ownerId: admitted.task.ownerId,
      jobId: admitted.task.jobId,
      leaseId: "lease-1",
      now: updatedAt,
      leaseExpiresAt: "2026-08-27T10:01:01.000Z",
      interruptedError: {
        code: "GENERATION_EXECUTION_INTERRUPTED",
        message: "interrupted",
        requestId: "request-1",
        retryable: false,
      },
    });

    const recreated = createService(database);
    await expect(
      recreated.persistence.tasks.findById("viewer-a", admitted.task.jobId, updatedAt),
    ).resolves.toMatchObject({
      status: { status: "generating" },
      execution: { leaseId: "lease-1", attempt: 1, providerCallStartedAt: null },
    });
    await expect(
      recreated.persistence.tasks.deleteExpired("2026-10-01T00:00:00.000Z"),
    ).resolves.toBe(1);
    await expect(
      recreated.persistence.idempotency.deleteExpired("2026-10-01T00:00:00.000Z"),
    ).resolves.toBe(1);
  });
});
