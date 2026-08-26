import type {
  ApiErrorResponse,
  DesignIntensity,
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

export async function createGeneration(
  input: CreateGenerationRequest,
): Promise<GenerationApiResponse> {
  const response = await Taro.uploadFile({
    url: `${API_BASE_URL}/api/v1/generations`,
    filePath: input.imagePath,
    name: "sourceImage",
    header: {
      "Idempotency-Key": createIdempotencyKey(),
    },
    formData: {
      mode: input.mode,
      preserveItems: input.preserveItems,
      changeRequest: input.changeRequest,
      styleDirection: input.styleDirection,
      intensity: input.intensity,
    },
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
      error.message ?? "生成失败，请稍后重试。",
      error.code ?? "GENERATION_FAILED",
      error.retryable ?? false,
    );
  }

  return payload as GenerationApiResponse;
}
