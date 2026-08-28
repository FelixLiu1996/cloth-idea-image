import type {
  DesignIntensity,
  GarmentAnalysisApiResponse,
  GenerationApiResponse,
  GenerationMode,
} from "@cloth-idea/domain";

export interface CreateGenerationRequest {
  readonly imagePath: string;
  readonly imageSize?: number;
  readonly mode: GenerationMode;
  readonly preserveItems: string;
  readonly changeRequest: string;
  readonly styleDirection: string;
  readonly intensity: DesignIntensity;
  readonly analysisId?: string;
  readonly directionId?: string;
  readonly parentJobId?: string;
  readonly accessCode?: string;
}

export interface RefineGenerationRequest {
  readonly parentJobId: string;
  readonly imagePath: string;
  readonly imageSize?: number;
  readonly instruction: string;
  readonly accessCode?: string;
}

export interface TrialCapabilities {
  readonly trialAccessRequired: boolean;
  readonly trialDailyAnalysisLimit: number;
  readonly trialDailyGenerationLimit: number;
  readonly assetRetentionHours: number;
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

export interface GarmentGateway {
  analyzeGarment(input: CreateGenerationRequest): Promise<GarmentAnalysisApiResponse>;
  createGeneration(input: CreateGenerationRequest): Promise<GenerationApiResponse>;
  refineGeneration(input: RefineGenerationRequest): Promise<GenerationApiResponse>;
  restorePendingGeneration(): Promise<GenerationApiResponse | null>;
  getTrialCapabilities(): Promise<TrialCapabilities>;
}
