import {
  GenerationTaskAdmissionService,
  IdempotencyConflictError,
  TrialQuotaExceededError,
  type AdmitGenerationTaskInput,
} from "@cloth-idea/application";
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

interface LessThanCondition {
  readonly operation: "lt";
  readonly value: string;
}

function isLessThanCondition(value: unknown): value is LessThanCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    "operation" in value &&
    value.operation === "lt" &&
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
          return isLessThanCondition(expected)
            ? typeof actual === "string" && actual < expected.value
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
    lt: (value: string): LessThanCondition => ({ operation: "lt", value }),
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

    await first.persistence.tasks.update({
      ...admitted.task,
      status: {
        jobId: admitted.task.jobId,
        status: "generating",
        statusUrl: input().statusUrl,
        createdAt,
        updatedAt,
      },
      updatedAt,
    });

    const recreated = createService(database);
    await expect(
      recreated.persistence.tasks.findById("viewer-a", admitted.task.jobId, updatedAt),
    ).resolves.toMatchObject({ status: { status: "generating" } });
    await expect(
      recreated.persistence.tasks.deleteExpired("2026-10-01T00:00:00.000Z"),
    ).resolves.toBe(1);
    await expect(
      recreated.persistence.idempotency.deleteExpired("2026-10-01T00:00:00.000Z"),
    ).resolves.toBe(1);
  });
});
