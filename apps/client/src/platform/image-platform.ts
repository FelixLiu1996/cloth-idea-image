import Taro from "@tarojs/taro";

export interface SelectedImage {
  readonly path: string;
  readonly size: number;
}

export async function selectGarmentImage(): Promise<SelectedImage | null> {
  try {
    const result = await Taro.chooseImage({
      count: 1,
      sizeType: ["compressed"],
      sourceType: ["album", "camera"],
    });
    const image = result.tempFiles[0];

    if (!image) {
      return null;
    }

    return { path: image.path, size: image.size };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("cancel")) {
      return null;
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "errMsg" in error) {
    const value = (error as { readonly errMsg?: unknown }).errMsg;
    return typeof value === "string" ? value : "";
  }
  return String(error);
}

async function saveToAlbum(filePath: string): Promise<void> {
  try {
    await Taro.saveImageToPhotosAlbum({ filePath });
  } catch (error) {
    const message = errorMessage(error).toLowerCase();
    if (message.includes("auth") || message.includes("deny") || message.includes("permission")) {
      throw new Error("没有相册保存权限，请在小程序设置中允许保存到相册。");
    }
    throw new Error("结果图片保存失败，请稍后重试。");
  }
}

export async function saveGeneratedImage(imageUrl: string): Promise<void> {
  if (imageUrl.startsWith("cloud://")) {
    let downloaded: { readonly tempFilePath?: string };
    try {
      downloaded = await Taro.cloud.downloadFile({ fileID: imageUrl });
    } catch {
      throw new Error("云端结果图片下载失败，请稍后重试。");
    }
    if (!downloaded.tempFilePath) {
      throw new Error("云端结果图片下载失败，请稍后重试。");
    }
    await saveToAlbum(downloaded.tempFilePath);
    return;
  }
  const downloaded = await Taro.downloadFile({
    url: imageUrl,
    withCredentials: false,
    timeout: 60_000,
  });
  if (downloaded.statusCode < 200 || downloaded.statusCode >= 300) {
    throw new Error("结果图片下载失败，请稍后重试。");
  }

  await saveToAlbum(downloaded.tempFilePath);
}
