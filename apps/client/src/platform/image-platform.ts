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
