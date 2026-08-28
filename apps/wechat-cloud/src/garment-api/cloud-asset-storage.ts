import type { GarmentAssetKind } from "@cloth-idea/application";
import type { SupportedImageMimeType } from "@cloth-idea/domain";

export interface WechatCloudStorageClient {
  uploadFile(input: {
    readonly cloudPath: string;
    readonly fileContent: Uint8Array;
  }): Promise<{ readonly fileID: string; readonly statusCode: number }>;
  downloadFile(input: {
    readonly fileID: string;
  }): Promise<{ readonly fileContent: Uint8Array; readonly statusCode: number }>;
  deleteFile(input: { readonly fileList: readonly string[] }): Promise<{
    readonly fileList: readonly {
      readonly fileID: string;
      readonly status: number;
      readonly errMsg?: string;
    }[];
  }>;
}

export interface SaveGarmentCloudAssetInput {
  readonly ownerId: string;
  readonly assetId: string;
  readonly kind: GarmentAssetKind;
  readonly mimeType: SupportedImageMimeType;
  readonly bytes: Uint8Array;
}

export interface SavedGarmentCloudAsset {
  readonly fileId: string;
  readonly cloudPath: string;
  readonly size: number;
}

const safePathSegment = /^[a-zA-Z0-9_-]{1,128}$/;

function extensionFor(mimeType: SupportedImageMimeType): "jpg" | "png" | "webp" {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

function assertSafePathSegment(name: string, value: string): void {
  if (!safePathSegment.test(value)) {
    throw new Error(`${name} 只能包含字母、数字、下划线和连字符。`);
  }
}

function assertSuccessfulStatus(
  statusCode: number,
  operation: string,
  allowUnobservedStatus = false,
): void {
  // wx-server-sdk may resolve uploadFile with a valid cloud:// file ID while
  // leaving statusCode at its internal "not observed" sentinel (-1).
  // A resolved request still has to pass the response-shape checks below.
  if (allowUnobservedStatus && statusCode === -1) {
    return;
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`${operation}失败。`);
  }
}

export class WechatCloudGarmentAssetStorage {
  constructor(private readonly client: WechatCloudStorageClient) {}

  async save(input: SaveGarmentCloudAssetInput): Promise<SavedGarmentCloudAsset> {
    assertSafePathSegment("ownerId", input.ownerId);
    assertSafePathSegment("assetId", input.assetId);
    if (input.bytes.byteLength === 0) {
      throw new Error("不能保存空图片。");
    }

    const extension = extensionFor(input.mimeType);
    const cloudPath =
      input.kind === "source"
        ? `garment-source-temp/${input.ownerId}/${input.assetId}.${extension}`
        : `garment-results/${input.ownerId}/${input.assetId}/result.${extension}`;
    const result = await this.client.uploadFile({
      cloudPath,
      fileContent: input.bytes,
    });
    assertSuccessfulStatus(result.statusCode, "云文件上传", true);
    if (!result.fileID.startsWith("cloud://")) {
      throw new Error("云文件上传返回了无效的文件 ID。");
    }
    return {
      fileId: result.fileID,
      cloudPath,
      size: input.bytes.byteLength,
    };
  }

  async read(fileId: string): Promise<Uint8Array> {
    if (!fileId.startsWith("cloud://")) {
      throw new Error("云文件 ID 格式无效。");
    }
    const result = await this.client.downloadFile({ fileID: fileId });
    assertSuccessfulStatus(result.statusCode, "云文件下载");
    return result.fileContent;
  }

  async delete(fileId: string): Promise<void> {
    if (!fileId.startsWith("cloud://")) {
      throw new Error("云文件 ID 格式无效。");
    }
    const result = await this.client.deleteFile({ fileList: [fileId] });
    const deletion = result.fileList[0];
    if (!deletion || deletion.fileID !== fileId || deletion.status !== 0) {
      throw new Error("云文件删除失败。");
    }
  }
}
