import { describe, expect, it, vi } from "vitest";

import {
  WechatCloudGarmentAssetStorage,
  type WechatCloudStorageClient,
} from "./cloud-asset-storage";

function createClient() {
  const files = new Map<string, Uint8Array>();
  const uploadFile: WechatCloudStorageClient["uploadFile"] = vi.fn(
    async ({ cloudPath, fileContent }) => {
      const fileID = `cloud://test-environment/${cloudPath}`;
      files.set(fileID, new Uint8Array(fileContent));
      return { fileID, statusCode: 200 };
    },
  );
  const downloadFile: WechatCloudStorageClient["downloadFile"] = vi.fn(async ({ fileID }) => {
    const fileContent = files.get(fileID);
    if (!fileContent) {
      return { fileContent: new Uint8Array(), statusCode: 404 };
    }
    return { fileContent: new Uint8Array(fileContent), statusCode: 200 };
  });
  const deleteFile: WechatCloudStorageClient["deleteFile"] = vi.fn(async ({ fileList }) => ({
    fileList: fileList.map((fileID: string) => {
      const deleted = files.delete(fileID);
      return { fileID, status: deleted ? 0 : -1 };
    }),
  }));
  return {
    files,
    client: { uploadFile, downloadFile, deleteFile } satisfies WechatCloudStorageClient,
  };
}

describe("WechatCloudGarmentAssetStorage", () => {
  it("stores source and result images under owner-scoped controlled paths", async () => {
    const { client } = createClient();
    const storage = new WechatCloudGarmentAssetStorage(client);

    const source = await storage.save({
      ownerId: "viewer-a",
      assetId: "source-1",
      kind: "source",
      mimeType: "image/jpeg",
      bytes: new Uint8Array([1, 2, 3]),
    });
    const result = await storage.save({
      ownerId: "viewer-a",
      assetId: "result-1",
      kind: "result",
      mimeType: "image/png",
      bytes: new Uint8Array([4, 5]),
    });

    expect(source).toMatchObject({
      cloudPath: "garment-source-temp/viewer-a/source-1.jpg",
      size: 3,
    });
    expect(result).toMatchObject({
      cloudPath: "garment-results/viewer-a/result-1/result.png",
      size: 2,
    });
    await expect(storage.read(result.fileId)).resolves.toEqual(new Uint8Array([4, 5]));
  });

  it("accepts the wx-server-sdk unresolved status sentinel when upload returns a valid file ID", async () => {
    const { client } = createClient();
    vi.mocked(client.uploadFile).mockResolvedValueOnce({
      fileID: "cloud://test-environment/garment-results/viewer-a/result-2/result.png",
      statusCode: -1,
    });
    const storage = new WechatCloudGarmentAssetStorage(client);

    await expect(
      storage.save({
        ownerId: "viewer-a",
        assetId: "result-2",
        kind: "result",
        mimeType: "image/png",
        bytes: new Uint8Array([4, 5]),
      }),
    ).resolves.toMatchObject({
      fileId: "cloud://test-environment/garment-results/viewer-a/result-2/result.png",
    });
  });

  it("still rejects an invalid file ID when upload status is unavailable", async () => {
    const { client } = createClient();
    vi.mocked(client.uploadFile).mockResolvedValueOnce({
      fileID: "invalid-file-id",
      statusCode: -1,
    });
    const storage = new WechatCloudGarmentAssetStorage(client);

    await expect(
      storage.save({
        ownerId: "viewer-a",
        assetId: "result-3",
        kind: "result",
        mimeType: "image/png",
        bytes: new Uint8Array([4, 5]),
      }),
    ).rejects.toThrow("无效的文件 ID");
  });

  it("does not accept the upload-only status sentinel for downloads", async () => {
    const { client } = createClient();
    vi.mocked(client.downloadFile).mockResolvedValueOnce({
      fileContent: new Uint8Array([1]),
      statusCode: -1,
    });
    const storage = new WechatCloudGarmentAssetStorage(client);

    await expect(storage.read("cloud://test-environment/source.jpg")).rejects.toThrow(
      "云文件下载失败",
    );
  });

  it("actively deletes a stored cloud file", async () => {
    const { client, files } = createClient();
    const storage = new WechatCloudGarmentAssetStorage(client);
    const saved = await storage.save({
      ownerId: "viewer-a",
      assetId: "asset-1",
      kind: "source",
      mimeType: "image/webp",
      bytes: new Uint8Array([1]),
    });

    await expect(storage.delete(saved.fileId)).resolves.toBeUndefined();
    expect(files.has(saved.fileId)).toBe(false);
    await expect(storage.delete(saved.fileId)).rejects.toThrow("云文件删除失败");
  });

  it("rejects unsafe paths and empty files before calling cloud storage", async () => {
    const { client } = createClient();
    const storage = new WechatCloudGarmentAssetStorage(client);

    await expect(
      storage.save({
        ownerId: "../other-user",
        assetId: "asset-1",
        kind: "source",
        mimeType: "image/jpeg",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("ownerId");
    await expect(
      storage.save({
        ownerId: "viewer-a",
        assetId: "asset-1",
        kind: "source",
        mimeType: "image/jpeg",
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow("不能保存空图片");
    expect(client.uploadFile).not.toHaveBeenCalled();
  });
});
