import { beforeEach, describe, expect, it, vi } from "vitest";

const { downloadFile, downloadCloudFile, saveImageToPhotosAlbum } = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  downloadCloudFile: vi.fn(),
  saveImageToPhotosAlbum: vi.fn(),
}));

vi.mock("@tarojs/taro", () => ({
  default: {
    cloud: { downloadFile: downloadCloudFile },
    downloadFile,
    saveImageToPhotosAlbum,
  },
}));

import { saveGeneratedImage } from "./image-platform";

describe("image platform result saving", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveImageToPhotosAlbum.mockResolvedValue(undefined);
  });

  it("downloads cloud:// results through the WeChat cloud SDK", async () => {
    downloadCloudFile.mockResolvedValue({ tempFilePath: "/tmp/cloud-result.jpg" });

    await saveGeneratedImage("cloud://env/garment-results/viewer/job/result.jpg");

    expect(downloadCloudFile).toHaveBeenCalledWith({
      fileID: "cloud://env/garment-results/viewer/job/result.jpg",
    });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(saveImageToPhotosAlbum).toHaveBeenCalledWith({
      filePath: "/tmp/cloud-result.jpg",
    });
  });

  it("keeps the existing HTTP download path for H5 results", async () => {
    downloadFile.mockResolvedValue({ statusCode: 200, tempFilePath: "/tmp/http-result.jpg" });

    await saveGeneratedImage("https://example.com/result.jpg");

    expect(downloadFile).toHaveBeenCalled();
    expect(downloadCloudFile).not.toHaveBeenCalled();
    expect(saveImageToPhotosAlbum).toHaveBeenCalledWith({
      filePath: "/tmp/http-result.jpg",
    });
  });

  it("returns an actionable message when album permission is denied", async () => {
    downloadCloudFile.mockResolvedValue({ tempFilePath: "/tmp/cloud-result.jpg" });
    saveImageToPhotosAlbum.mockRejectedValue({ errMsg: "saveImageToPhotosAlbum:fail auth deny" });

    await expect(
      saveGeneratedImage("cloud://env/garment-results/viewer/job/result.jpg"),
    ).rejects.toThrow("没有相册保存权限，请在小程序设置中允许保存到相册。");
  });

  it("does not expose raw cloud download failures", async () => {
    downloadCloudFile.mockRejectedValue(new Error("internal cloud storage detail"));

    await expect(
      saveGeneratedImage("cloud://env/garment-results/viewer/job/result.jpg"),
    ).rejects.toThrow("云端结果图片下载失败，请稍后重试。");
  });
});
