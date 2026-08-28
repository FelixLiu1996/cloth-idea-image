import type { GenerationApiResponse } from "@cloth-idea/domain";
import { describe, expect, it } from "vitest";

import { ApplicationStateConflictError } from "./errors";
import { GenerationTaskAdmissionService } from "./generation-task-admission";
import { GenerationTaskExecutionService } from "./generation-task-execution";
import {
  MemoryGenerationTaskRepository,
  MemoryIdempotencyRepository,
  MemoryTransactionRunner,
  MemoryTrialQuotaRepository,
} from "./memory-repositories";

const createdAt = "2026-08-27T10:00:00.000Z";
const jobId = "00000000-0000-4000-8000-000000000001";

async function createHarness() {
  const tasks = new MemoryGenerationTaskRepository();
  const idempotency = new MemoryIdempotencyRepository();
  const quotas = new MemoryTrialQuotaRepository();
  const transactions = new MemoryTransactionRunner([tasks, idempotency, quotas]);
  const task = (
    await new GenerationTaskAdmissionService({ tasks, idempotency, quotas, transactions }).admit({
      ownerId: "viewer-a",
      action: "generation",
      idempotencyKey: "generation-key-1",
      requestFingerprint: "fingerprint-a",
      jobId,
      statusUrl: `wechat-cloud://generation-jobs/${jobId}`,
      createdAt,
      expiresAt: "2026-09-27T10:00:00.000Z",
      quotaReservations: [],
    })
  ).task;
  return {
    tasks,
    task,
    service: new GenerationTaskExecutionService({ tasks, transactions }),
  };
}

function claimInput(leaseId: string, now = createdAt) {
  return {
    ownerId: "viewer-a",
    jobId,
    leaseId,
    now,
    leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
    interruptedError: {
      code: "GENERATION_EXECUTION_INTERRUPTED",
      message: "执行中断，未自动重试以避免重复调用模型。",
      requestId: "request-1",
      retryable: false,
    },
  } as const;
}

describe("GenerationTaskExecutionService", () => {
  it("allows only one active lease for concurrent execution claims", async () => {
    const harness = await createHarness();

    const [first, second] = await Promise.all([
      harness.service.claim(claimInput("lease-1")),
      harness.service.claim(claimInput("lease-2")),
    ]);

    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
    const claimed = first.claimed ? first : second;
    expect(claimed.task.status.status).toBe("generating");
    expect(claimed.task.execution).toMatchObject({ attempt: 1, providerCallStartedAt: null });
  });

  it("reclaims an expired lease only before the provider call starts", async () => {
    const harness = await createHarness();
    await harness.service.claim(claimInput("lease-1"));

    const reclaimed = await harness.service.claim(
      claimInput("lease-2", "2026-08-27T10:02:00.000Z"),
    );

    expect(reclaimed.claimed).toBe(true);
    expect(reclaimed.task.execution).toMatchObject({ leaseId: "lease-2", attempt: 2 });
  });

  it("fails an interrupted paid call instead of starting a duplicate provider request", async () => {
    const harness = await createHarness();
    await harness.service.claim(claimInput("lease-1"));
    await harness.service.markProviderCallStarted({
      ownerId: "viewer-a",
      jobId,
      leaseId: "lease-1",
      now: "2026-08-27T10:00:10.000Z",
    });

    const recovered = await harness.service.claim(
      claimInput("lease-2", "2026-08-27T10:02:00.000Z"),
    );

    expect(recovered.claimed).toBe(false);
    expect(recovered.task.status).toMatchObject({
      status: "failed",
      error: { code: "GENERATION_EXECUTION_INTERRUPTED", retryable: false },
    });
  });

  it("accepts completion only from the current lease", async () => {
    const harness = await createHarness();
    await harness.service.claim(claimInput("lease-1"));
    const succeeded: GenerationApiResponse = {
      jobId,
      status: "succeeded",
      provider: "testing-fake",
      model: "fake-image-copy-v1",
      resultUrl: "cloud://environment/result.jpg",
      summary: "测试完成",
      durationMs: 1,
      strategy: "direct",
      directionId: null,
      directionName: null,
      operation: "initial",
      parentJobId: null,
      revisionInstruction: null,
      createdAt,
    };

    await expect(
      harness.service.complete({
        ownerId: "viewer-a",
        jobId,
        leaseId: "lease-2",
        now: createdAt,
        status: succeeded,
      }),
    ).rejects.toBeInstanceOf(ApplicationStateConflictError);
    await expect(
      harness.service.complete({
        ownerId: "viewer-a",
        jobId,
        leaseId: "lease-1",
        now: createdAt,
        status: succeeded,
      }),
    ).resolves.toMatchObject({ status: { status: "succeeded" } });
  });
});
