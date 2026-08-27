import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalAssetStore } from "./asset-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalAssetStore", () => {
  it("removes only expired UUID result directories when cleanup is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloth-idea-assets-"));
    temporaryDirectories.push(root);
    const expiredJobId = "00000000-0000-0000-0000-000000000001";
    const currentJobId = "00000000-0000-0000-0000-000000000002";
    const unrelatedDirectory = join(root, "manual-backup");
    const expiredDirectory = join(root, expiredJobId);
    const currentDirectory = join(root, currentJobId);
    await Promise.all([
      mkdir(expiredDirectory),
      mkdir(currentDirectory),
      mkdir(unrelatedDirectory),
    ]);
    await Promise.all([
      writeFile(join(expiredDirectory, "result.png"), "old"),
      writeFile(join(currentDirectory, "result.png"), "new"),
    ]);
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    const expiredAt = new Date(now - 25 * 60 * 60 * 1_000);
    await utimes(expiredDirectory, expiredAt, expiredAt);

    const store = new LocalAssetStore(root);
    const removed = await store.pruneExpiredResults(24 * 60 * 60 * 1_000, now);

    expect(removed).toBe(1);
    await expect(store.readResult(expiredJobId, "result.png")).resolves.toBeNull();
    await expect(store.readResult(currentJobId, "result.png")).resolves.not.toBeNull();
    await expect(statDirectory(unrelatedDirectory)).resolves.toBe(true);
  });

  it("does not remove files when cleanup is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloth-idea-assets-"));
    temporaryDirectories.push(root);
    const store = new LocalAssetStore(root);

    await expect(store.pruneExpiredResults(0)).resolves.toBe(0);
  });
});

async function statDirectory(path: string): Promise<boolean> {
  return (await stat(path)).isDirectory();
}
