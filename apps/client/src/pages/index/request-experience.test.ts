import { describe, expect, it } from "vitest";

import { GenerationApiError } from "../../services/garment-gateway";
import { createRequestFailure, createRequestProgress } from "./request-experience";

const weappOptions = { supportsPendingRestore: true };
const h5Options = { supportsPendingRestore: false };

describe("request experience", () => {
  it("advances analysis feedback conservatively by elapsed time", () => {
    expect(createRequestProgress("analysis", 0, weappOptions)).toMatchObject({
      activeStep: 0,
      elapsedSeconds: 0,
      progressPercent: 8,
      estimate: "预计还需约 50 秒",
    });
    expect(createRequestProgress("analysis", 12, weappOptions)).toMatchObject({
      activeStep: 1,
      estimate: "预计还需约 40 秒",
    });
    expect(createRequestProgress("analysis", 61, weappOptions)).toMatchObject({
      activeStep: 2,
      progressPercent: 92,
      estimate: "已等待 61 秒，任务仍在处理中",
    });
  });

  it("explains that generation work can be recovered after task creation", () => {
    const progress = createRequestProgress("generation", 17, weappOptions);

    expect(progress.activeStep).toBe(2);
    expect(progress.navigationHint).toContain("重新进入小程序");
  });

  it("does not claim that H5 can restore a pending generation", () => {
    expect(createRequestProgress("generation", 17, h5Options).navigationHint).not.toContain(
      "重新进入小程序",
    );
  });

  it("asks for the original image again without discarding the failure context", () => {
    const failure = createRequestFailure(
      "refinement",
      new GenerationApiError("原图已过期。", "PARENT_ASSET_EXPIRED", false),
      weappOptions,
    );

    expect(failure).toMatchObject({
      recovery: "reselect-source",
      actionLabel: "重新选择原图",
    });
    expect(failure.guidance).toContain("保留当前版本");
  });

  it("recovers a missing refinement source by asking for the original image", () => {
    expect(
      createRequestFailure(
        "refinement",
        new GenerationApiError("缺少原图。", "REFINEMENT_SOURCE_REQUIRED", false),
        weappOptions,
      ),
    ).toMatchObject({ recovery: "reselect-source", actionLabel: "重新选择原图" });
  });

  it("does not encourage duplicate submission when task status is uncertain", () => {
    const failure = createRequestFailure(
      "generation",
      new GenerationApiError("仍在处理中。", "GENERATION_POLL_TIMEOUT", true),
      weappOptions,
    );

    expect(failure).toMatchObject({ recovery: "wait", actionLabel: "返回当前页面" });
    expect(failure.guidance).toContain("不要连续提交");
  });

  it("keeps an uncertain H5 request safe without promising mini-program restore", () => {
    const failure = createRequestFailure(
      "generation",
      new GenerationApiError("网络暂时不可用。", "NETWORK_ERROR", true),
      h5Options,
    );

    expect(failure.recovery).toBe("wait");
    expect(failure.guidance).not.toContain("重新进入小程序");
  });

  it("makes model cost explicit for a user-triggered retry", () => {
    const failure = createRequestFailure(
      "generation",
      new GenerationApiError("模型暂时不可用。", "PROVIDER_UNAVAILABLE", true),
      weappOptions,
    );

    expect(failure).toMatchObject({ recovery: "retry", actionLabel: "重新提交" });
    expect(failure.guidance).toContain("1 次生图额度");
  });

  it("routes authorization and quota errors without offering a retry", () => {
    expect(
      createRequestFailure(
        "analysis",
        new GenerationApiError("未加入体验名单。", "AUTH_TRIAL_MEMBER_REQUIRED", false),
        weappOptions,
      ).recovery,
    ).toBe("review-access");
    expect(
      createRequestFailure(
        "generation",
        new GenerationApiError("今日额度已用完。", "RATE_LIMIT_DAILY_GENERATION_REACHED", false),
        weappOptions,
      ).recovery,
    ).toBe("limit");
  });
});
