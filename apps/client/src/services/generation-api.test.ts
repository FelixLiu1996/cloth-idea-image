import type {
  GenerationApiResponse,
  GenerationJobPendingResponse,
  GenerationJobStatusResponse,
} from "@cloth-idea/domain";
import Taro from "@tarojs/taro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGeneration, type CreateGenerationRequest } from "./generation-api";

vi.mock("@tarojs/taro", () => ({
  default: {
    uploadFile: vi.fn(),
    request: vi.fn(),
  },
}));

const input: CreateGenerationRequest = {
  imagePath: "/tmp/jacket.png",
  mode: "quick-derivative",
  preserveItems: "格纹袖口",
  changeRequest: "改成复古工装短夹克",
  styleDirection: "九十年代日系工装",
  intensity: "medium",
};

const queued: GenerationJobPendingResponse = {
  jobId: "00000000-0000-0000-0000-000000000001",
  status: "queued",
  statusUrl: "http://example.test/api/v1/generations/00000000-0000-0000-0000-000000000001",
  createdAt: "2026-08-27T10:00:00.000Z",
  updatedAt: "2026-08-27T10:00:00.000Z",
};

const succeeded: GenerationApiResponse = {
  jobId: queued.jobId,
  status: "succeeded",
  provider: "alibaba-qwen-image",
  model: "qwen-image-2.0-pro-2026-06-22",
  resultUrl: "http://example.test/api/v1/assets/job/result.png",
  summary: "快速衍生",
  durationMs: 18_000,
  strategy: "direct",
  directionId: null,
  directionName: null,
  operation: "initial",
  parentJobId: null,
  revisionInstruction: null,
  createdAt: queued.createdAt,
};

const uploadFile = vi.mocked(Taro.uploadFile);
const request = vi.mocked(Taro.request);

describe("generation API service", () => {
  beforeEach(() => {
    vi.stubGlobal("API_BASE_URL", "http://example.test");
    vi.useFakeTimers();
    uploadFile.mockReset();
    request.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("submits an async job and polls until it succeeds", async () => {
    uploadFile.mockResolvedValue({ statusCode: 202, data: JSON.stringify(queued) } as never);
    request.mockResolvedValue({ statusCode: 200, data: succeeded } as never);

    const resultPromise = createGeneration(input);
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual(succeeded);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: `http://example.test/api/v1/generations/${queued.jobId}`,
      }),
    );
  });

  it("reuses the idempotency key when the submission transport is retried", async () => {
    uploadFile
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ statusCode: 202, data: JSON.stringify(queued) } as never);
    request.mockResolvedValue({ statusCode: 200, data: succeeded } as never);

    const resultPromise = createGeneration(input);
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toEqual(succeeded);

    const firstHeader = uploadFile.mock.calls[0]?.[0].header;
    const secondHeader = uploadFile.mock.calls[1]?.[0].header;
    expect(firstHeader?.["Idempotency-Key"]).toBeTruthy();
    expect(secondHeader?.["Idempotency-Key"]).toBe(firstHeader?.["Idempotency-Key"]);
  });

  it("keeps polling the same job after a temporary status request failure", async () => {
    uploadFile.mockResolvedValue({ statusCode: 202, data: JSON.stringify(queued) } as never);
    request.mockRejectedValueOnce(new Error("temporary disconnect")).mockResolvedValueOnce({
      statusCode: 200,
      data: succeeded,
    } as never);

    const resultPromise = createGeneration(input);
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual(succeeded);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces an asynchronous provider failure", async () => {
    const failed: GenerationJobStatusResponse = {
      jobId: queued.jobId,
      status: "failed",
      error: {
        code: "PROVIDER_RATE_LIMITED",
        message: "模型请求过于频繁，请稍后重试。",
        requestId: "req-1",
        retryable: true,
      },
      createdAt: queued.createdAt,
      updatedAt: "2026-08-27T10:00:01.000Z",
    };
    uploadFile.mockResolvedValue({ statusCode: 202, data: JSON.stringify(queued) } as never);
    request.mockResolvedValue({ statusCode: 200, data: failed } as never);

    const resultPromise = createGeneration(input);
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      retryable: true,
    });
    await vi.runAllTimersAsync();
    await rejection;
  });
});
