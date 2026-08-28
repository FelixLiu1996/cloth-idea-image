import {
  GarmentDataCleanupService,
  type GarmentAnalysisRepository,
  type GarmentAssetRepository,
  type GenerationTaskRepository,
  type IdempotencyRepository,
} from "@cloth-idea/application";

export const garmentCleanupTriggerName = "garment-expired-data-cleanup";

export interface GarmentCleanupHandlerDependencies {
  readonly analyses: GarmentAnalysisRepository;
  readonly assets: GarmentAssetRepository;
  readonly tasks: GenerationTaskRepository;
  readonly idempotency: IdempotencyRepository;
  readonly deleteFile: (fileId: string) => Promise<void>;
  readonly now: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGarmentCleanupTimerEvent(event: unknown): boolean {
  return (
    isRecord(event) && event.Type === "Timer" && event.TriggerName === garmentCleanupTriggerName
  );
}

export function createGarmentCleanupHandler(dependencies: GarmentCleanupHandlerDependencies) {
  const service = new GarmentDataCleanupService(dependencies);
  return async () => {
    const startedAt = dependencies.now();
    const result = await service.run(startedAt);
    return { ok: result.assetDeletionFailures === 0, startedAt, ...result };
  };
}
