import Taro from "@tarojs/taro";

const pendingGenerationJobStorageKey = "cloth-idea-pending-generation-job";

export interface PendingGenerationJobStore {
  read(): string | null;
  write(jobId: string): void;
  clear(): void;
}

export const pendingGenerationJobStore: PendingGenerationJobStore = {
  read() {
    try {
      const value = Taro.getStorageSync<string>(pendingGenerationJobStorageKey);
      return typeof value === "string" && value.trim() ? value : null;
    } catch {
      return null;
    }
  },
  write(jobId) {
    Taro.setStorageSync(pendingGenerationJobStorageKey, jobId);
  },
  clear() {
    Taro.removeStorageSync(pendingGenerationJobStorageKey);
  },
};
