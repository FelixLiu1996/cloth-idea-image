import { describe, expect, it, vi } from "vitest";

import { GarmentDataCleanupService } from "./garment-data-cleanup";
import type { GarmentAssetRecord } from "./ports";

const now = "2026-08-27T12:00:00.000Z";

function asset(assetId: string, fileId: string): GarmentAssetRecord {
  return {
    assetId,
    ownerId: "viewer-a",
    kind: "source",
    fileId,
    mimeType: "image/jpeg",
    size: 3,
    createdAt: "2026-08-27T10:00:00.000Z",
    expiresAt: "2026-08-27T11:00:00.000Z",
  };
}

describe("GarmentDataCleanupService", () => {
  it("deletes physical files before metadata and keeps failed files retryable", async () => {
    const records = [
      asset("asset-1", "cloud://environment/shared.jpg"),
      asset("asset-2", "cloud://environment/shared.jpg"),
      asset("asset-3", "cloud://environment/failing.jpg"),
    ];
    const deletedRecords: string[] = [];
    const deleteFile = vi.fn(async (fileId: string) => {
      if (fileId.endsWith("failing.jpg")) {
        throw new Error("temporary storage failure");
      }
    });
    const service = new GarmentDataCleanupService({
      analyses: { findById: vi.fn(), save: vi.fn(), deleteExpired: vi.fn(async () => 2) },
      assets: {
        findById: vi.fn(),
        findExpired: vi.fn(async () => records),
        hasActiveFileReference: vi.fn(async () => false),
        save: vi.fn(),
        delete: vi.fn(async (_ownerId, assetId) => {
          deletedRecords.push(assetId);
          return true;
        }),
      },
      tasks: {
        findById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deleteExpired: vi.fn(async () => 3),
      },
      idempotency: {
        find: vi.fn(),
        create: vi.fn(),
        deleteExpired: vi.fn(async () => 4),
      },
      deleteFile,
    });

    await expect(service.run(now)).resolves.toEqual({
      expiredAssetsFound: 3,
      assetFilesDeleted: 1,
      assetFilesRetained: 0,
      assetRecordsDeleted: 2,
      assetDeletionFailures: 1,
      analysesDeleted: 2,
      tasksDeleted: 3,
      idempotencyRecordsDeleted: 4,
    });
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deletedRecords).toEqual(["asset-1", "asset-2"]);
  });

  it("keeps a shared physical file while another active asset still references it", async () => {
    const expired = asset("asset-expired", "cloud://environment/shared.jpg");
    const deleteFile = vi.fn();
    const deleteRecord = vi.fn(async () => true);
    const service = new GarmentDataCleanupService({
      analyses: { findById: vi.fn(), save: vi.fn(), deleteExpired: vi.fn(async () => 0) },
      assets: {
        findById: vi.fn(),
        findExpired: vi.fn(async () => [expired]),
        hasActiveFileReference: vi.fn(async () => true),
        save: vi.fn(),
        delete: deleteRecord,
      },
      tasks: {
        findById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deleteExpired: vi.fn(async () => 0),
      },
      idempotency: {
        find: vi.fn(),
        create: vi.fn(),
        deleteExpired: vi.fn(async () => 0),
      },
      deleteFile,
    });

    await expect(service.run(now)).resolves.toMatchObject({
      assetFilesDeleted: 0,
      assetFilesRetained: 1,
      assetRecordsDeleted: 1,
    });
    expect(deleteFile).not.toHaveBeenCalled();
    expect(deleteRecord).toHaveBeenCalledWith("viewer-a", "asset-expired");
  });
});
