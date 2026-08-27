import { describe, expect, it, vi } from "vitest";

import {
  createGarmentCleanupHandler,
  garmentCleanupTriggerName,
  isGarmentCleanupTimerEvent,
} from "./cleanup-handler";

describe("garment cleanup timer handler", () => {
  it("accepts only the configured CloudBase timer event", () => {
    expect(
      isGarmentCleanupTimerEvent({ Type: "Timer", TriggerName: garmentCleanupTriggerName }),
    ).toBe(true);
    expect(isGarmentCleanupTimerEvent({ Type: "Timer", TriggerName: "other" })).toBe(false);
    expect(
      isGarmentCleanupTimerEvent({ action: "cleanup", TriggerName: garmentCleanupTriggerName }),
    ).toBe(false);
  });

  it("returns cleanup counts without exposing asset identifiers", async () => {
    const handler = createGarmentCleanupHandler({
      analyses: { findById: vi.fn(), save: vi.fn(), deleteExpired: vi.fn(async () => 1) },
      assets: {
        findById: vi.fn(),
        findExpired: vi.fn(async () => []),
        hasActiveFileReference: vi.fn(async () => false),
        save: vi.fn(),
        delete: vi.fn(),
      },
      tasks: {
        findById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deleteExpired: vi.fn(async () => 2),
      },
      idempotency: {
        find: vi.fn(),
        create: vi.fn(),
        deleteExpired: vi.fn(async () => 3),
      },
      deleteFile: vi.fn(),
      now: () => "2026-08-27T12:00:00.000Z",
    });

    await expect(handler()).resolves.toEqual({
      ok: true,
      startedAt: "2026-08-27T12:00:00.000Z",
      expiredAssetsFound: 0,
      assetFilesDeleted: 0,
      assetFilesRetained: 0,
      assetRecordsDeleted: 0,
      assetDeletionFailures: 0,
      analysesDeleted: 1,
      tasksDeleted: 2,
      idempotencyRecordsDeleted: 3,
    });
  });
});
