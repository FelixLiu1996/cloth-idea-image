import { describe, expect, it, vi } from "vitest";

vi.mock("@tarojs/taro", () => ({
  default: { cloud: {} },
}));

import {
  createWechatCloudInfrastructureProbe,
  deleteWechatCloudInfrastructureProbe,
  getWechatCloudInfrastructureCapabilities,
  getWechatCloudInfrastructureProbe,
  type WechatCloudInfrastructureClient,
} from "./wechat-cloud-infrastructure";

describe("WeChat cloud infrastructure service", () => {
  it("uploads a source image and persists a probe through the cloud function", async () => {
    const uploadFile = vi.fn().mockResolvedValue({ fileID: "cloud://env/source.png" });
    const callFunction = vi.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        result:
          data.action === "get-capabilities"
            ? {
                ok: true,
                data: {
                  transport: "wechat-cloud",
                  authorized: true,
                  viewerFingerprint: "abcdef1234567890",
                  trialAccessRequired: false,
                  trialDailyAnalysisLimit: 0,
                  trialDailyGenerationLimit: 0,
                  assetRetentionHours: 0,
                },
              }
            : {
                ok: true,
                data: {
                  probeId: "a".repeat(32),
                  status: "succeeded",
                  cloudFileId:
                    "cloud://env/garment-source-temp/abcdef1234567890/incoming/source.png",
                  fileName: "source.png",
                  mimeType: "image/png",
                  size: 120,
                  createdAt: "2026-08-27T12:00:00.000Z",
                },
              },
      }),
    );
    const client = { uploadFile, callFunction } as WechatCloudInfrastructureClient;

    await expect(
      createWechatCloudInfrastructureProbe({ path: "/tmp/source.png", size: 120 }, client),
    ).resolves.toMatchObject({ probeId: "a".repeat(32), status: "succeeded" });
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudPath: expect.stringMatching(
          /^garment-source-temp\/abcdef1234567890\/incoming\/.+\.png$/,
        ),
        filePath: "/tmp/source.png",
      }),
    );
    expect(callFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "garment-api",
        data: expect.objectContaining({
          action: "create-infrastructure-probe",
          cloudFileId: "cloud://env/source.png",
          mimeType: "image/png",
          size: 120,
        }),
      }),
    );
  });

  it("reads the viewer fingerprint without exposing OPENID", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: true,
        data: {
          transport: "wechat-cloud",
          authorized: false,
          viewerFingerprint: "abcdef1234567890",
          trialAccessRequired: false,
          trialDailyAnalysisLimit: 0,
          trialDailyGenerationLimit: 0,
          assetRetentionHours: 0,
        },
      },
    });

    await expect(getWechatCloudInfrastructureCapabilities({ callFunction })).resolves.toMatchObject(
      {
        viewerFingerprint: "abcdef1234567890",
        authorized: false,
      },
    );
  });

  it("retrieves a persisted probe by ID", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: true,
        data: {
          probeId: "a".repeat(32),
          status: "succeeded",
          cloudFileId: "cloud://env/source.jpg",
          fileName: "source.jpg",
          mimeType: "image/jpeg",
          size: 120,
          createdAt: "2026-08-27T12:00:00.000Z",
        },
      },
    });

    await expect(
      getWechatCloudInfrastructureProbe("a".repeat(32), { callFunction }),
    ).resolves.toMatchObject({ probeId: "a".repeat(32) });
  });

  it("deletes a persisted probe and its cloud file through the cloud function", async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: true,
        data: { probeId: "a".repeat(32), status: "deleted" },
      },
    });

    await expect(
      deleteWechatCloudInfrastructureProbe("a".repeat(32), { callFunction }),
    ).resolves.toEqual({ probeId: "a".repeat(32), status: "deleted" });
    expect(callFunction).toHaveBeenCalledWith({
      name: "garment-api",
      data: { action: "delete-infrastructure-probe", probeId: "a".repeat(32) },
    });
  });

  it("does not upload before the current viewer is authorized", async () => {
    const uploadFile = vi.fn();
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: true,
        data: {
          transport: "wechat-cloud",
          authorized: false,
          viewerFingerprint: "abcdef1234567890",
          trialAccessRequired: false,
          trialDailyAnalysisLimit: 0,
          trialDailyGenerationLimit: 0,
          assetRetentionHours: 0,
        },
      },
    });

    await expect(
      createWechatCloudInfrastructureProbe({ path: "/tmp/source.png", size: 120 }, {
        uploadFile,
        callFunction,
      } as WechatCloudInfrastructureClient),
    ).rejects.toMatchObject({ code: "AUTH_TRIAL_MEMBER_REQUIRED", retryable: false });
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
