import type {
  GarmentAnalysisProviderInput,
  GarmentAnalysisProviderResult,
} from "@cloth-idea/domain";

import { GarmentProviderError } from "./garment-image-provider";

export interface GarmentAnalysisProvider {
  readonly provider: GarmentAnalysisProviderResult["provider"];
  readonly model: string;
  readonly configured: boolean;

  analyze(input: GarmentAnalysisProviderInput): Promise<GarmentAnalysisProviderResult>;
}

export class UnconfiguredGarmentAnalysisProvider implements GarmentAnalysisProvider {
  readonly provider = "alibaba-qwen-vl" as const;
  readonly model: string;
  readonly configured = false;

  constructor(model = "qwen3.7-plus") {
    this.model = model;
  }

  async analyze(): Promise<never> {
    throw new GarmentProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "服装视觉分析服务尚未配置，请检查服务端环境变量。",
    );
  }
}
