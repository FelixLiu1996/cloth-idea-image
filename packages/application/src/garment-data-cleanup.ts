import type {
  GarmentAnalysisRepository,
  GarmentAssetRecord,
  GarmentAssetRepository,
  GenerationTaskRepository,
  IdempotencyRepository,
} from "./ports";

export interface GarmentDataCleanupDependencies {
  readonly analyses: GarmentAnalysisRepository;
  readonly assets: GarmentAssetRepository;
  readonly tasks: GenerationTaskRepository;
  readonly idempotency: IdempotencyRepository;
  readonly deleteFile: (fileId: string) => Promise<void>;
}

export interface GarmentDataCleanupResult {
  readonly expiredAssetsFound: number;
  readonly assetFilesDeleted: number;
  readonly assetFilesRetained: number;
  readonly assetRecordsDeleted: number;
  readonly assetDeletionFailures: number;
  readonly analysesDeleted: number;
  readonly tasksDeleted: number;
  readonly idempotencyRecordsDeleted: number;
}

export class GarmentDataCleanupService {
  constructor(private readonly dependencies: GarmentDataCleanupDependencies) {}

  async run(now: string, batchSize = 100): Promise<GarmentDataCleanupResult> {
    if (!Number.isFinite(Date.parse(now))) {
      throw new Error("清理时间必须使用有效的 ISO 8601 字符串。");
    }
    if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 100) {
      throw new Error("单次清理数量必须是 1 到 100 的整数。");
    }

    const expiredAssets = await this.dependencies.assets.findExpired(now, batchSize);
    let assetFilesDeleted = 0;
    let assetFilesRetained = 0;
    let assetRecordsDeleted = 0;
    let assetDeletionFailures = 0;
    const recordsByFile = new Map<string, GarmentAssetRecord[]>();
    for (const record of expiredAssets) {
      const records = recordsByFile.get(record.fileId) ?? [];
      records.push(record);
      recordsByFile.set(record.fileId, records);
    }

    for (const [fileId, records] of recordsByFile) {
      if (await this.dependencies.assets.hasActiveFileReference(fileId, now)) {
        assetFilesRetained += 1;
        for (const record of records) {
          if (await this.dependencies.assets.delete(record.ownerId, record.assetId)) {
            assetRecordsDeleted += 1;
          }
        }
        continue;
      }
      try {
        await this.dependencies.deleteFile(fileId);
        assetFilesDeleted += 1;
      } catch {
        assetDeletionFailures += records.length;
        continue;
      }
      for (const record of records) {
        if (await this.dependencies.assets.delete(record.ownerId, record.assetId)) {
          assetRecordsDeleted += 1;
        }
      }
    }

    const [analysesDeleted, tasksDeleted, idempotencyRecordsDeleted] = await Promise.all([
      this.dependencies.analyses.deleteExpired(now),
      this.dependencies.tasks.deleteExpired(now),
      this.dependencies.idempotency.deleteExpired(now),
    ]);
    return {
      expiredAssetsFound: expiredAssets.length,
      assetFilesDeleted,
      assetFilesRetained,
      assetRecordsDeleted,
      assetDeletionFailures,
      analysesDeleted,
      tasksDeleted,
      idempotencyRecordsDeleted,
    };
  }
}
