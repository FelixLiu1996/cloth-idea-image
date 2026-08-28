import Taro from "@tarojs/taro";

export interface WechatCloudRuntime {
  init(options: { readonly env: string; readonly traceUser: boolean }): void;
}

export interface InitializeWechatCloudOptions {
  readonly platform: string | undefined;
  readonly environmentId: string;
  readonly cloud: WechatCloudRuntime;
}

export function initializeWechatCloud(options: InitializeWechatCloudOptions): void {
  if (options.platform !== "weapp") {
    return;
  }
  if (!options.environmentId.trim()) {
    throw new Error("TARO_APP_WECHAT_CLOUD_ENV_ID is required for WeChat builds");
  }
  options.cloud.init({ env: options.environmentId, traceUser: true });
}

export function initializeConfiguredWechatCloud(): void {
  initializeWechatCloud({
    platform: process.env.TARO_ENV,
    environmentId: WECHAT_CLOUD_ENV_ID,
    cloud: Taro.cloud,
  });
}
