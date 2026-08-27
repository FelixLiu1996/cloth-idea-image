import Taro from "@tarojs/taro";

const trialAccessCodeStorageKey = "cloth-idea-trial-access-code";

export function readTrialAccessCode(): string {
  try {
    const value = Taro.getStorageSync<string>(trialAccessCodeStorageKey);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export function saveTrialAccessCode(value: string): void {
  const normalized = value.trim();
  if (normalized) {
    Taro.setStorageSync(trialAccessCodeStorageKey, normalized);
    return;
  }
  Taro.removeStorageSync(trialAccessCodeStorageKey);
}
