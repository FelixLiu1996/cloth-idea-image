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
});
