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

    const first = repository.executeOnce("same-key", operation);
    const second = repository.executeOnce("same-key", operation);
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

    await expect(repository.executeOnce("retry-key", failedOperation)).rejects.toThrow(
      "temporary failure",
    );
    await expect(repository.executeOnce("retry-key", async () => result)).resolves.toEqual({
      result,
      reused: false,
    });
  });
});
