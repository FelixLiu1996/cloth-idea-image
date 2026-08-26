import type {
  ApiErrorResponse,
  DesignIntensity,
  GarmentAnalysisApiResponse,
  GenerationApiResponse,
  GenerationMode,
} from "@cloth-idea/domain";
import Taro from "@tarojs/taro";

export interface CreateGenerationRequest {
  readonly imagePath: string;
  readonly mode: GenerationMode;
  readonly preserveItems: string;
  readonly changeRequest: string;
  readonly styleDirection: string;
  readonly intensity: DesignIntensity;
  readonly analysisId?: string;
  readonly directionId?: string;
}

function createIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function uploadGarmentRequest<TResponse>(
  path: "/api/v1/analyses" | "/api/v1/generations",
  input: CreateGenerationRequest,
): Promise<TResponse> {
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

  const response = await Taro.uploadFile({
    url: `${API_BASE_URL}${path}`,
    filePath: input.imagePath,
    name: "sourceImage",
    header: {
      "Idempotency-Key": createIdempotencyKey(),
    },
    formData,
  });

  let payload: unknown;
  try {
    payload = JSON.parse(response.data);
  } catch {
    throw new GenerationApiError("服务返回了无法识别的结果。", "BAD_RESPONSE", true);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = payload as Partial<ApiErrorResponse>;
    throw new GenerationApiError(
      error.message ?? "请求失败，请稍后重试。",
      error.code ?? "GARMENT_REQUEST_FAILED",
      error.retryable ?? false,
    );
  }

  return payload as TResponse;
}

export async function analyzeGarment(
  input: CreateGenerationRequest,
): Promise<GarmentAnalysisApiResponse> {
  return uploadGarmentRequest("/api/v1/analyses", input);
}

export async function createGeneration(
  input: CreateGenerationRequest,
): Promise<GenerationApiResponse> {
  return uploadGarmentRequest("/api/v1/generations", input);
}
