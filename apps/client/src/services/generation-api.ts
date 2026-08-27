import type {
  ApiErrorResponse,
  DesignIntensity,
  GarmentAnalysisApiResponse,
  GenerationApiResponse,
  GenerationJobStatusResponse,
  GenerationMode,
} from "@cloth-idea/domain";
import Taro from "@tarojs/taro";

const ANALYSIS_REQUEST_TIMEOUT_MS = 180_000;
const GENERATION_SUBMIT_TIMEOUT_MS = 30_000;
const GENERATION_POLL_REQUEST_TIMEOUT_MS = 15_000;
const GENERATION_POLL_INTERVAL_MS = 1_000;
const GENERATION_POLL_BUDGET_MS = 360_000;

export interface CreateGenerationRequest {
  readonly imagePath: string;
  readonly mode: GenerationMode;
  readonly preserveItems: string;
  readonly changeRequest: string;
  readonly styleDirection: string;
  readonly intensity: DesignIntensity;
  readonly analysisId?: string;
  readonly directionId?: string;
  readonly parentJobId?: string;
}

export interface RefineGenerationRequest {
  readonly parentJobId: string;
  readonly imagePath: string;
  readonly instruction: string;
}

function createIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class GenerationApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GenerationApiError";
  }
}

function parsePayload(data: unknown): unknown {
  if (typeof data !== "string") {
    return data;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new GenerationApiError("服务返回了无法识别的结果。", "BAD_RESPONSE", true);
  }
}

function apiErrorFromPayload(payload: unknown, fallbackCode: string): GenerationApiError {
  const error = payload as Partial<ApiErrorResponse>;
  return new GenerationApiError(
    error.message ?? "请求失败，请稍后重试。",
    error.code ?? fallbackCode,
    error.retryable ?? false,
  );
}

async function uploadMultipart<TResponse>(options: {
  readonly path: string;
  readonly imagePath: string;
  readonly formData: Record<string, string>;
  readonly timeoutMs: number;
  readonly fallbackErrorCode: string;
  readonly retryTransportOnce: boolean;
}): Promise<TResponse> {
  const idempotencyKey = createIdempotencyKey();

  for (let attempt = 0; attempt < (options.retryTransportOnce ? 2 : 1); attempt += 1) {
    try {
      const response = await Taro.uploadFile({
        url: `${API_BASE_URL}${options.path}`,
        filePath: options.imagePath,
        name: "sourceImage",
        withCredentials: false,
        timeout: options.timeoutMs,
        header: {
          "Idempotency-Key": idempotencyKey,
        },
        formData: options.formData,
      });
      const payload = parsePayload(response.data);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw apiErrorFromPayload(payload, options.fallbackErrorCode);
      }
      return payload as TResponse;
    } catch (error) {
      if (error instanceof GenerationApiError) {
        throw error;
      }
      if (attempt === 0 && options.retryTransportOnce) {
        await wait(500);
      }
    }
  }

  throw new GenerationApiError("网络连接中断，请稍后重试。", "NETWORK_ERROR", true);
}

function createGenerationFormData(input: CreateGenerationRequest): Record<string, string> {
  const formData: Record<string, string> = {
    mode: input.mode,
    preserveItems: input.preserveItems,
    changeRequest: input.changeRequest,
    styleDirection: input.styleDirection,
    intensity: input.intensity,
  };
  if (input.analysisId && input.directionId) {
    formData.analysisId = input.analysisId;
    formData.directionId = input.directionId;
  }
  if (input.parentJobId) {
    formData.parentJobId = input.parentJobId;
  }
  return formData;
}

function parseGenerationJob(payload: unknown): GenerationJobStatusResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new GenerationApiError("任务状态无法识别。", "BAD_RESPONSE", true);
  }
  const status = (payload as { readonly status?: unknown }).status;
  if (
    status !== "queued" &&
    status !== "generating" &&
    status !== "succeeded" &&
    status !== "failed"
  ) {
    throw new GenerationApiError("任务状态无法识别。", "BAD_RESPONSE", true);
  }
  return payload as GenerationJobStatusResponse;
}

async function requestGenerationJob(jobId: string): Promise<GenerationJobStatusResponse> {
  const response = await Taro.request<unknown>({
    url: `${API_BASE_URL}/api/v1/generations/${jobId}`,
    method: "GET",
    credentials: "omit",
    timeout: GENERATION_POLL_REQUEST_TIMEOUT_MS,
  });
  const payload = parsePayload(response.data);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw apiErrorFromPayload(payload, "GENERATION_STATUS_FAILED");
  }
  return parseGenerationJob(payload);
}

async function waitForGenerationJob(
  initialJob: GenerationJobStatusResponse,
): Promise<GenerationApiResponse> {
  let job = initialJob;
  const deadline = Date.now() + GENERATION_POLL_BUDGET_MS;

  while (true) {
    if (job.status === "succeeded") {
      return job;
    }
    if (job.status === "failed") {
      throw new GenerationApiError(job.error.message, job.error.code, job.error.retryable);
    }
    if (Date.now() >= deadline) {
      throw new GenerationApiError(
        "生成任务处理超出预期，服务端可能仍在继续，请不要立即重复提交。",
        "GENERATION_POLL_TIMEOUT",
        true,
      );
    }

    await wait(GENERATION_POLL_INTERVAL_MS);
    try {
      job = await requestGenerationJob(job.jobId);
    } catch (error) {
      if (error instanceof GenerationApiError && !error.retryable) {
        throw error;
      }
    }
  }
}

export async function analyzeGarment(
  input: CreateGenerationRequest,
): Promise<GarmentAnalysisApiResponse> {
  return uploadMultipart({
    path: "/api/v1/analyses",
    imagePath: input.imagePath,
    formData: createGenerationFormData(input),
    timeoutMs: ANALYSIS_REQUEST_TIMEOUT_MS,
    fallbackErrorCode: "GARMENT_ANALYSIS_FAILED",
    retryTransportOnce: false,
  });
}

export async function createGeneration(
  input: CreateGenerationRequest,
): Promise<GenerationApiResponse> {
  const submitted = await uploadMultipart<GenerationJobStatusResponse>({
    path: "/api/v1/generations",
    imagePath: input.imagePath,
    formData: createGenerationFormData(input),
    timeoutMs: GENERATION_SUBMIT_TIMEOUT_MS,
    fallbackErrorCode: "GARMENT_GENERATION_FAILED",
    retryTransportOnce: true,
  });
  return waitForGenerationJob(parseGenerationJob(submitted));
}

export async function refineGeneration(
  input: RefineGenerationRequest,
): Promise<GenerationApiResponse> {
  const submitted = await uploadMultipart<GenerationJobStatusResponse>({
    path: `/api/v1/generations/${input.parentJobId}/refinements`,
    imagePath: input.imagePath,
    formData: { instruction: input.instruction },
    timeoutMs: GENERATION_SUBMIT_TIMEOUT_MS,
    fallbackErrorCode: "GARMENT_REFINEMENT_FAILED",
    retryTransportOnce: true,
  });
  return waitForGenerationJob(parseGenerationJob(submitted));
}
