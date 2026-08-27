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

    const first = repository.enqueueOnce(jobInput(operation));
    const second = repository.enqueueOnce(
      jobInput(operation, { jobId: "00000000-0000-0000-0000-000000000002" }),
    );

    expect(first).toMatchObject({ reused: false, job: { status: "queued", jobId: result.jobId } });
    expect(second).toMatchObject({ reused: true, job: { jobId: result.jobId } });
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    expect(repository.getJob(result.jobId)?.status).toBe("generating");

    release();
    await vi.waitFor(() => expect(repository.getJob(result.jobId)?.status).toBe("succeeded"));
    expect(repository.get(result.jobId)?.response).toEqual(result);
  });

  it("keeps a failed task bound to its idempotency key", async () => {
    const repository = new GenerationResultRepository();
    const failedOperation = vi.fn(async () => {
      throw new Error("temporary failure");
    });
    const retryOperation = vi.fn(async () => record);

    repository.enqueueOnce(jobInput(failedOperation));
    await vi.waitFor(() => expect(repository.getJob(result.jobId)?.status).toBe("failed"));

    const repeated = repository.enqueueOnce(jobInput(retryOperation));
    expect(repeated).toMatchObject({
      reused: true,
      job: { status: "failed", jobId: result.jobId },
    });
    expect(retryOperation).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key for a different request", () => {
    const repository = new GenerationResultRepository();
    repository.enqueueOnce(jobInput(async () => record));

    expect(() =>
      repository.enqueueOnce(
        jobInput(async () => record, {
          jobId: "00000000-0000-0000-0000-000000000002",
          requestFingerprint: "request-two",
        }),
      ),
    ).toThrow("同一个幂等键不能用于不同的生成请求");
  });

  it("stores successful generation records for later refinement", () => {
    const repository = new GenerationResultRepository();
    repository.save(record);

    expect(repository.get(result.jobId)?.response).toEqual(result);
    expect(repository.getJob(result.jobId)).toEqual(result);
    expect(repository.get("00000000-0000-0000-0000-000000000999")).toBeNull();
  });
});
