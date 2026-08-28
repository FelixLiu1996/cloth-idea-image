import type { GenerationApiResponse } from "@cloth-idea/domain";
import { describe, expect, it, vi } from "vitest";

import {
  GenerationResultRepository,
  type EnqueueGenerationJobInput,
  type StoredGenerationRecord,
} from "./generation-repository";

const result: GenerationApiResponse = {
  jobId: "00000000-0000-0000-0000-000000000001",
  status: "succeeded",
  provider: "alibaba-wan",
  model: "fake-wan",
  resultUrl: "http://example.test/result.png",
  summary: "快速衍生",
  durationMs: 100,
  strategy: "direct",
  directionId: null,
  directionName: null,
  operation: "initial",
  parentJobId: null,
  revisionInstruction: null,
  createdAt: "2026-08-26T12:00:00.000Z",
};

const record: StoredGenerationRecord = {
  response: result,
  assetFileName: "result.png",
  assetMimeType: "image/png",
  basePrompt: "base prompt",
  baseSummary: "快速衍生",
  baseRequestFingerprint: "request",
  sourceImageSha256: "source-image-sha256",
  revisionInstructions: [],
};

function jobInput(
  operation: EnqueueGenerationJobInput["operation"],
  overrides: Partial<EnqueueGenerationJobInput> = {},
): EnqueueGenerationJobInput {
  return {
    jobId: result.jobId,
    action: "generation",
    statusUrl: `http://example.test/api/v1/generations/${result.jobId}`,
    createdAt: result.createdAt,
    idempotencyKey: "same-key",
    requestFingerprint: "same-request",
    operation,
    mapError: () => ({
      code: "PROVIDER_UNAVAILABLE",
      message: "模型暂时不可用。",
      requestId: "req-1",
      retryable: true,
    }),
    ...overrides,
  };
}

describe("GenerationResultRepository", () => {
  it("returns a queued job immediately and shares it for the same idempotency key", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      await gate;
      return record;
    });
    const repository = new GenerationResultRepository();

    const first = await repository.enqueueOnce(jobInput(operation));
    const second = await repository.enqueueOnce(
      jobInput(operation, {
        jobId: "00000000-0000-0000-0000-000000000002",
      }),
    );

    expect(first).toMatchObject({ reused: false, job: { status: "queued", jobId: result.jobId } });
    expect(second).toMatchObject({ reused: true, job: { jobId: result.jobId } });
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    expect((await repository.getJob(result.jobId))?.status).toBe("generating");

    release();
    await vi.waitFor(async () =>
      expect((await repository.getJob(result.jobId))?.status).toBe("succeeded"),
    );
    expect(repository.get(result.jobId)?.response).toEqual(result);
  });

  it("keeps a failed task bound to its idempotency key", async () => {
    const repository = new GenerationResultRepository();
    const failedOperation = vi.fn(async () => {
      throw new Error("temporary failure");
    });
    const retryOperation = vi.fn(async () => record);

    await repository.enqueueOnce(jobInput(failedOperation));
    await vi.waitFor(async () =>
      expect((await repository.getJob(result.jobId))?.status).toBe("failed"),
    );

    const repeated = await repository.enqueueOnce(jobInput(retryOperation));
    expect(repeated).toMatchObject({
      reused: true,
      job: { status: "failed", jobId: result.jobId },
    });
    expect(retryOperation).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const repository = new GenerationResultRepository();
    await repository.enqueueOnce(jobInput(async () => record));

    await expect(
      repository.enqueueOnce(
        jobInput(async () => record, {
          jobId: "00000000-0000-0000-0000-000000000002",
          requestFingerprint: "request-two",
        }),
      ),
    ).rejects.toThrow("同一个幂等键不能用于不同的请求");
  });

  it("does not create a job when the shared quota admission rejects it", async () => {
    const repository = new GenerationResultRepository({ dailyGenerationLimit: 1 });
    await repository.enqueueOnce(jobInput(async () => record));
    const rejectedJobId = "00000000-0000-0000-0000-000000000002";

    await expect(
      repository.enqueueOnce(
        jobInput(async () => record, {
          jobId: rejectedJobId,
          idempotencyKey: "second-key",
          requestFingerprint: "second-request",
        }),
      ),
    ).rejects.toThrow("今日生图额度已用完");
    await expect(repository.getJob(rejectedJobId)).resolves.toBeNull();
  });

  it("stores successful generation records for later refinement", async () => {
    const repository = new GenerationResultRepository();
    await repository.enqueueOnce(jobInput(async () => record, { idempotencyKey: undefined }));
    await vi.waitFor(() => expect(repository.get(result.jobId)?.response).toEqual(result));

    expect(repository.get(result.jobId)?.response).toEqual(result);
    await expect(repository.getJob(result.jobId)).resolves.toEqual(result);
    expect(repository.get("00000000-0000-0000-0000-000000000999")).toBeNull();
  });
});
