import type { GenerationApiResponse } from "@cloth-idea/domain";
import { describe, expect, it, vi } from "vitest";

import { GenerationResultRepository } from "./generation-repository";

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

describe("GenerationResultRepository", () => {
  it("shares an in-flight operation for the same idempotency key", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      await gate;
      return result;
    });
    const repository = new GenerationResultRepository();

    const first = repository.executeOnce("same-key", "same-request", operation);
    const second = repository.executeOnce("same-key", "same-request", operation);
    release();

    await expect(first).resolves.toEqual({ result, reused: false });
    await expect(second).resolves.toEqual({ result, reused: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("allows a failed operation to be retried", async () => {
    const repository = new GenerationResultRepository();
    const failedOperation = vi.fn(async () => {
      throw new Error("temporary failure");
    });

    await expect(repository.executeOnce("retry-key", "request", failedOperation)).rejects.toThrow(
      "temporary failure",
    );
    await expect(
      repository.executeOnce("retry-key", "request", async () => result),
    ).resolves.toEqual({ result, reused: false });
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const repository = new GenerationResultRepository();

    await repository.executeOnce("same-key", "request-one", async () => result);

    await expect(
      repository.executeOnce("same-key", "request-two", async () => result),
    ).rejects.toThrow("同一个幂等键不能用于不同的生成请求");
  });

  it("stores generation records for later refinement", () => {
    const repository = new GenerationResultRepository();
    repository.save({
      response: result,
      assetFileName: "result.png",
      assetMimeType: "image/png",
      basePrompt: "base prompt",
      baseSummary: "快速衍生",
      baseRequestFingerprint: "request",
      sourceImageSha256: "source-image-sha256",
      revisionInstructions: [],
    });

    expect(repository.get(result.jobId)?.response).toEqual(result);
    expect(repository.get("00000000-0000-0000-0000-000000000999")).toBeNull();
  });
});
