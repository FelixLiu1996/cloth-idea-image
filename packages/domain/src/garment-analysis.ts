import { z } from "zod";

import type {
  DesignIntensity,
  GenerationMode,
  ProviderUsage,
  SourceImageInput,
} from "./generation";

export const evidenceLevels = ["visible", "inferred", "unknown"] as const;
export type EvidenceLevel = (typeof evidenceLevels)[number];

export const garmentFactKeys = [
  "category",
  "silhouette",
  "length",
  "shoulder",
  "collar",
  "closure",
  "sleeve",
  "cuff",
  "pockets",
  "frontPanels",
  "backPanels",
  "fabric",
  "color",
  "trims",
  "craftsmanship",
  "presentation",
] as const;
export type GarmentFactKey = (typeof garmentFactKeys)[number];

export const garmentChangeAreas = [
  "silhouette",
  "proportion",
  "shoulder",
  "collar",
  "closure",
  "sleeve",
  "cuff",
  "pockets",
  "panels",
  "fabric",
  "color",
  "trims",
  "craftsmanship",
  "presentation",
] as const;
export type GarmentChangeArea = (typeof garmentChangeAreas)[number];

const factValueSchema = z.union([z.string(), z.array(z.string()), z.null()]);

export const garmentFactSchema = z.object({
  value: factValueSchema,
  evidenceLevel: z.enum(evidenceLevels),
  confidence: z.number().min(0).max(1),
  evidence: z.string().trim().min(1).max(1_000),
});
export type GarmentFact = z.infer<typeof garmentFactSchema>;

export const garmentVisualFactsSchema = z.object({
  category: garmentFactSchema,
  silhouette: garmentFactSchema,
  length: garmentFactSchema,
  shoulder: garmentFactSchema,
  collar: garmentFactSchema,
  closure: garmentFactSchema,
  sleeve: garmentFactSchema,
  cuff: garmentFactSchema,
  pockets: garmentFactSchema,
  frontPanels: garmentFactSchema,
  backPanels: garmentFactSchema,
  fabric: garmentFactSchema,
  color: garmentFactSchema,
  trims: garmentFactSchema,
  craftsmanship: garmentFactSchema,
  presentation: garmentFactSchema,
});
export type GarmentVisualFacts = z.infer<typeof garmentVisualFactsSchema>;

export const designChangeSchema = z.object({
  area: z.enum(garmentChangeAreas),
  instruction: z.string().trim().min(2).max(500),
  reason: z.string().trim().min(2).max(500),
});
export type DesignChange = z.infer<typeof designChangeSchema>;

export const productionRiskSchema = z.object({
  level: z.enum(["low", "medium", "high"]),
  newPatternPieces: z.array(z.string().trim().min(1)).max(12),
  newTrims: z.array(z.string().trim().min(1)).max(12),
  newOperations: z.array(z.string().trim().min(1)).max(12),
  fitOrStructureRisks: z.array(z.string().trim().min(1)).max(12),
  reason: z.string().trim().min(2).max(1_000),
});
export type ProductionRisk = z.infer<typeof productionRiskSchema>;

export const designDirectionSchema = z.object({
  id: z.string().regex(/^direction-[1-3]$/),
  name: z.string().trim().min(2).max(80),
  summary: z.string().trim().min(2).max(500),
  changes: z.array(designChangeSchema).min(2).max(16),
  preserve: z.array(z.string().trim().min(1)).max(16),
  productionRisk: productionRiskSchema,
  promptRequirements: z.object({
    positive: z.array(z.string().trim().min(1)).max(20),
    hardConstraints: z.array(z.string().trim().min(1)).max(20),
    negative: z.array(z.string().trim().min(1)).max(20),
  }),
});
export type DesignDirection = z.infer<typeof designDirectionSchema>;

export const garmentAnalysisSchema = z
  .object({
    schemaVersion: z.literal("garment-dna-v0.2"),
    visualFacts: garmentVisualFactsSchema,
    userConstraints: z.object({
      preserve: z.array(z.string().trim().min(1)).max(16),
      modify: z.array(z.string().trim().min(1)).max(16),
      avoid: z.array(z.string().trim().min(1)).max(16),
    }),
    conflictsOrQuestions: z.array(z.string().trim().min(1)).max(12),
    designDirections: z.array(designDirectionSchema).length(3),
    recommendedDirectionId: z.string().regex(/^direction-[1-3]$/),
    recommendationReason: z.string().trim().min(2).max(1_000),
  })
  .superRefine((analysis, context) => {
    const ids = analysis.designDirections.map((direction) => direction.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["designDirections"],
        message: "三个设计方向必须使用不同的 id。",
      });
    }
    if (!ids.includes(analysis.recommendedDirectionId)) {
      context.addIssue({
        code: "custom",
        path: ["recommendedDirectionId"],
        message: "推荐方向必须指向已返回的设计方向。",
      });
    }
  });
export type GarmentAnalysis = z.infer<typeof garmentAnalysisSchema>;

export interface GarmentAnalysisBrief {
  readonly mode: GenerationMode;
  readonly preserveItems: readonly string[];
  readonly changeRequest: string;
  readonly styleDirection: string;
  readonly intensity: DesignIntensity;
}

export interface GarmentAnalysisProviderInput {
  readonly sourceImage: SourceImageInput;
  readonly brief: GarmentAnalysisBrief;
  readonly schemaVersion: "garment-dna-v0.2";
}

export interface GarmentAnalysisProviderResult {
  readonly provider: "alibaba-qwen-vl";
  readonly model: string;
  readonly providerRequestId: string | null;
  readonly durationMs: number;
  readonly usage: ProviderUsage;
  readonly analysis: GarmentAnalysis;
}

export interface GarmentAnalysisApiResponse {
  readonly analysisId: string;
  readonly status: "succeeded";
  readonly provider: GarmentAnalysisProviderResult["provider"];
  readonly model: string;
  readonly durationMs: number;
  readonly analysis: GarmentAnalysis;
  readonly evidenceSummary: {
    readonly accepted: number;
    readonly needsReview: number;
    readonly unknown: number;
  };
}

export interface ClassifiedGarmentFact {
  readonly key: GarmentFactKey;
  readonly fact: GarmentFact;
}

export interface EvidenceGateResult {
  readonly accepted: readonly ClassifiedGarmentFact[];
  readonly needsReview: readonly ClassifiedGarmentFact[];
  readonly unknown: readonly ClassifiedGarmentFact[];
}

export function applyEvidenceGate(
  facts: GarmentVisualFacts,
  minimumVisibleConfidence = 0.75,
): EvidenceGateResult {
  const accepted: ClassifiedGarmentFact[] = [];
  const needsReview: ClassifiedGarmentFact[] = [];
  const unknown: ClassifiedGarmentFact[] = [];

  for (const key of garmentFactKeys) {
    const fact = facts[key];
    const classified = { key, fact };
    if (fact.evidenceLevel === "unknown" || fact.value === null) {
      unknown.push(classified);
    } else if (fact.evidenceLevel === "visible" && fact.confidence >= minimumVisibleConfidence) {
      accepted.push(classified);
    } else {
      needsReview.push(classified);
    }
  }

  return { accepted, needsReview, unknown };
}

export function findDesignDirection(
  analysis: GarmentAnalysis,
  directionId: string,
): DesignDirection | null {
  return analysis.designDirections.find((direction) => direction.id === directionId) ?? null;
}
