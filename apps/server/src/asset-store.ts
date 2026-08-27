import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type { GeneratedImageAsset, SupportedImageMimeType } from "@cloth-idea/domain";

const extensions: Record<SupportedImageMimeType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const mimeTypesByExtension = new Map<string, SupportedImageMimeType>([
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const safeJobIdPattern = /^[0-9a-f-]{36}$/i;
const safeFileNamePattern = /^result\.(?:jpg|png|webp)$/;

export interface StoredAsset {
  readonly fileName: string;
  readonly mimeType: SupportedImageMimeType;
}

export class LocalAssetStore {
  constructor(private readonly rootDirectory: string) {}

  async saveResult(jobId: string, asset: GeneratedImageAsset): Promise<StoredAsset> {
    if (!safeJobIdPattern.test(jobId)) {
      throw new Error("无效的任务编号。");
    }

    const fileName = `result${extensions[asset.mimeType]}`;
    const directory = join(this.rootDirectory, jobId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileName), asset.bytes);

    return { fileName, mimeType: asset.mimeType };
  }

  async readResult(
    jobId: string,
    fileName: string,
  ): Promise<{ bytes: Buffer; mimeType: SupportedImageMimeType } | null> {
    if (!safeJobIdPattern.test(jobId) || !safeFileNamePattern.test(fileName)) {
      return null;
    }

    const mimeType = mimeTypesByExtension.get(extname(fileName));
    if (!mimeType) {
      return null;
    }

    try {
      return {
        bytes: await readFile(join(this.rootDirectory, jobId, fileName)),
        mimeType,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async pruneExpiredResults(retentionMs: number, now = Date.now()): Promise<number> {
    if (retentionMs <= 0) {
      return 0;
    }

    let entries;
    try {
      entries = await readdir(this.rootDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeJobIdPattern.test(entry.name)) {
        continue;
      }
      const directory = join(this.rootDirectory, entry.name);
      const metadata = await stat(directory);
      if (metadata.mtimeMs > now - retentionMs) {
        continue;
      }
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}
