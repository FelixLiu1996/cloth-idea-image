export type WechatCloudTrialAccessMode = "fingerprint-allowlist" | "wechat-experience";

export interface WechatCloudTrialAccessConfiguration {
  readonly mode: WechatCloudTrialAccessMode;
  readonly experienceAccessUntil: string | null;
  readonly configurationError: string | null;
}

export type FingerprintTrialMemberLookup = (viewerFingerprint: string) => Promise<boolean>;

function fingerprintAllowlist(
  configurationError: string | null,
): WechatCloudTrialAccessConfiguration {
  return {
    mode: "fingerprint-allowlist",
    experienceAccessUntil: null,
    configurationError,
  };
}

export function createWechatCloudTrialAccessConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): WechatCloudTrialAccessConfiguration {
  const requestedMode = environment.WECHAT_CLOUD_TRIAL_ACCESS_MODE?.trim();
  if (!requestedMode || requestedMode === "fingerprint-allowlist") {
    return fingerprintAllowlist(null);
  }
  if (requestedMode !== "wechat-experience") {
    return fingerprintAllowlist("微信云端体验权限模式无效，已回退到指纹白名单。");
  }

  const experienceAccessUntil = environment.WECHAT_CLOUD_EXPERIENCE_ACCESS_UNTIL?.trim();
  if (!experienceAccessUntil || !Number.isFinite(Date.parse(experienceAccessUntil))) {
    return fingerprintAllowlist("微信体验成员直通模式缺少有效截止时间，已回退到指纹白名单。");
  }
  return {
    mode: "wechat-experience",
    experienceAccessUntil,
    configurationError: null,
  };
}

export function createWechatCloudTrialMemberAuthorizer(
  configuration: WechatCloudTrialAccessConfiguration,
  isFingerprintAllowlisted: FingerprintTrialMemberLookup,
  now: () => number = Date.now,
): FingerprintTrialMemberLookup {
  const experienceAccessUntil = configuration.experienceAccessUntil
    ? Date.parse(configuration.experienceAccessUntil)
    : null;

  return async (viewerFingerprint) => {
    if (
      configuration.mode === "wechat-experience" &&
      experienceAccessUntil !== null &&
      now() < experienceAccessUntil
    ) {
      return true;
    }
    return isFingerprintAllowlisted(viewerFingerprint);
  };
}
