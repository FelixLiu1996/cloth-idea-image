import { describe, expect, it } from "vitest";

import {
  ApplicationStateConflictError,
  GenerationTaskAdmissionService,
  IdempotencyConflictError,
  TrialQuotaExceededError,
} from "./index";
import {
  MemoryGenerationTaskRepository,
  MemoryIdempotencyRepository,
  MemoryTransactionRunner,
  MemoryTrialQuotaRepository,
} from "./memory-repositories";
import type { AdmitGenerationTaskInput } from "./generation-task-admission";

const createdAt = "2026-08-27T10:00:00.000Z";
const expiresAt = "2026-09-26T10:00:00.000Z";

function createHarness() {
  const tasks = new MemoryGenerationTaskRepository();
  const idempotency = new MemoryIdempotencyRepository();
  const quotas = new MemoryTrialQuotaRepository();
  const transactions = new MemoryTransactionRunner([tasks, idempotency, quotas]);
  return {
    tasks,
    idempotency,
    quotas,
    service: new GenerationTaskAdmissionService({
      tasks,
      idempotency,
      quotas,
      transactions,
    }),
    recreateService: () =>
      new GenerationTaskAdmissionService({ tasks, idempotency, quotas, transactions }),
  };
}

function input(overrides: Partial<AdmitGenerationTaskInput> = {}): AdmitGenerationTaskInput {
  return {
    ownerId: "viewer-a",
    action: "generation",
    idempotencyKey: "generation-key-1",
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

describe("GenerationTaskAdmissionService", () => {
  it("creates one queued task and reserves both user and global quota", async () => {
    const harness = createHarness();

    const result = await harness.service.admit(input());

    expect(result.reused).toBe(false);
    expect(result.task.status.status).toBe("queued");
    await expect(
      harness.quotas.getUsage("user", "viewer-a", "generation", "2026-08-27"),
    ).resolves.toBe(1);
    await expect(
      harness.quotas.getUsage("global", "trial", "generation", "2026-08-27"),
    ).resolves.toBe(1);
  });

  it("serializes concurrent retries and returns the same task without double charging quota", async () => {
    const harness = createHarness();

    const [first, second] = await Promise.all([
      harness.service.admit(input()),
      harness.service.admit(input()),
    ]);

    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(first.task.jobId).toBe(second.task.jobId);
    await expect(
      harness.quotas.getUsage("user", "viewer-a", "generation", "2026-08-27"),
    ).resolves.toBe(1);
  });

  it("keeps idempotency across service recreation", async () => {
    const harness = createHarness();
    await harness.service.admit(input());

    const result = await harness.recreateService().admit(input());

    expect(result.reused).toBe(true);
    expect(result.task.jobId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects the same idempotency key for a different request", async () => {
    const harness = createHarness();
    await harness.service.admit(input());

    await expect(
      harness.service.admit(input({ requestFingerprint: "fingerprint-b" })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      harness.quotas.getUsage("user", "viewer-a", "generation", "2026-08-27"),
    ).resolves.toBe(1);
  });

  it("rejects an over-quota request without creating a task or idempotency record", async () => {
    const harness = createHarness();
    const overQuota = input({
      quotaReservations: [
        {
          scope: "user",
          subjectId: "viewer-a",
          kind: "generation",
          day: "2026-08-27",
          amount: 1,
          limit: 0,
        },
        {
          scope: "global",
          subjectId: "trial",
          kind: "generation",
          day: "2026-08-27",
          amount: 2,
          limit: 1,
        },
      ],
    });

    await expect(harness.service.admit(overQuota)).rejects.toBeInstanceOf(TrialQuotaExceededError);
    await expect(
      harness.tasks.findById(overQuota.ownerId, overQuota.jobId, createdAt),
    ).resolves.toBeNull();
    await expect(
      harness.idempotency.find(
        overQuota.ownerId,
        overQuota.action,
        overQuota.idempotencyKey,
        createdAt,
      ),
    ).resolves.toBeNull();
  });

  it("rolls quota back when a later task write conflicts", async () => {
    const harness = createHarness();
    await harness.service.admit(input());

    const conflictingTask = input({
      idempotencyKey: "generation-key-2",
      requestFingerprint: "fingerprint-b",
    });
    await expect(harness.service.admit(conflictingTask)).rejects.toBeInstanceOf(
      ApplicationStateConflictError,
    );

    await expect(
      harness.quotas.getUsage("user", "viewer-a", "generation", "2026-08-27"),
    ).resolves.toBe(1);
    await expect(
      harness.idempotency.find(
        conflictingTask.ownerId,
        conflictingTask.action,
        conflictingTask.idempotencyKey,
        createdAt,
      ),
    ).resolves.toBeNull();
  });
});
