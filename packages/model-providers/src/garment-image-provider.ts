import type { GarmentGenerationInput, GarmentGenerationResult } from "@cloth-idea/domain";

export interface GarmentImageProvider {
  readonly provider: GarmentGenerationResult["provider"];
  readonly model: string;
  readonly configured: boolean;

  generateVariation(input: GarmentGenerationInput): Promise<GarmentGenerationResult>;
}

export type ProviderErrorCode =
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_REJECTED_INPUT"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_BAD_RESPONSE"
  | "PROVIDER_UNAVAILABLE";

interface GarmentProviderErrorOptions {
  readonly cause?: unknown;
  readonly requestId?: string | undefined;
  readonly retryable?: boolean;
}

export class GarmentProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly requestId: string | undefined;
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, options: GarmentProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "GarmentProviderError";
    this.code = code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
  }
}

export class UnconfiguredGarmentImageProvider implements GarmentImageProvider {
  readonly provider = "alibaba-wan" as const;
  readonly model: string;
  readonly configured = false;

  constructor(model = "wan2.7-image-pro") {
    this.model = model;
  }

  async generateVariation(): Promise<never> {
    throw new GarmentProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "生图服务尚未配置，请检查服务端环境变量。",
    );
  }
}
