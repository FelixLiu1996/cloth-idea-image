import { supportedImageMimeTypes, type SupportedImageMimeType } from "@cloth-idea/domain";
import cloud from "wx-server-sdk";

import {
  createDefaultRequestId,
  createGarmentCloudHandler,
  type StoredInfrastructureProbe,
} from "./handler";
import {
  createWechatCloudApplicationPersistence,
  type WechatCloudDatabase,
} from "./cloud-application-persistence";
import { WechatCloudGarmentAssetStorage } from "./cloud-asset-storage";

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV as unknown as string });

const database = cloud.database();
export const applicationPersistence = createWechatCloudApplicationPersistence(
  database as unknown as WechatCloudDatabase,
);
export const garmentAssetStorage = new WechatCloudGarmentAssetStorage({
  uploadFile: ({ cloudPath, fileContent }) =>
    cloud.uploadFile({ cloudPath, fileContent: Buffer.from(fileContent) }),
  downloadFile: async ({ fileID }) => {
    const result = await cloud.downloadFile({ fileID });
    return { fileContent: result.fileContent, statusCode: result.statusCode };
  },
  deleteFile: async ({ fileList }) => {
    const result = await cloud.deleteFile({ fileList: [...fileList] });
    if (!result) {
      throw new Error("cloud file deletion returned no result");
    }
    return result;
  },
});
const trialMembers = database.collection("trial_members");
const infrastructureProbes = database.collection("infrastructure_probes");
const supportedMimeTypes = new Set<string>(supportedImageMimeTypes);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredProbe(value: unknown): StoredInfrastructureProbe | null {
  if (
    !isRecord(value) ||
    typeof value.probeId !== "string" ||
    value.status !== "succeeded" ||
    typeof value.ownerFingerprint !== "string" ||
    typeof value.requestFingerprint !== "string" ||
    typeof value.cloudFileId !== "string" ||
    typeof value.fileName !== "string" ||
    typeof value.mimeType !== "string" ||
    !supportedMimeTypes.has(value.mimeType) ||
    typeof value.size !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    probeId: value.probeId,
    status: value.status,
    ownerFingerprint: value.ownerFingerprint,
    requestFingerprint: value.requestFingerprint,
    cloudFileId: value.cloudFileId,
    fileName: value.fileName,
    mimeType: value.mimeType as SupportedImageMimeType,
    size: value.size,
    createdAt: value.createdAt,
  };
}

function isMissingDocument(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { readonly errCode?: unknown; readonly code?: unknown };
  return candidate.errCode === -1 || candidate.code === "DATABASE_REQUEST_DOCUMENT_NOT_FOUND";
}

const handler = createGarmentCloudHandler({
  getOpenId: () => cloud.getWXContext().OPENID,
  repository: {
    async isTrialMember(viewerFingerprint) {
      try {
        const result = await trialMembers.doc(viewerFingerprint).get();
        const data = (result as { readonly data?: unknown }).data;
        return (
          typeof data === "object" &&
          data !== null &&
          (data as { readonly active?: unknown }).active === true
        );
      } catch (error) {
        if (isMissingDocument(error)) {
          return false;
        }
        throw error;
      }
    },
    async findInfrastructureProbe(probeId) {
      try {
        const result = await infrastructureProbes.doc(probeId).get();
        const data = (result as { readonly data?: unknown }).data;
        return parseStoredProbe(data);
      } catch (error) {
        if (isMissingDocument(error)) {
          return null;
        }
        throw error;
      }
    },
    async saveInfrastructureProbe(probe) {
      await infrastructureProbes.doc(probe.probeId).set({ data: probe });
    },
    async deleteInfrastructureProbe(probeId) {
      await infrastructureProbes.doc(probeId).remove();
    },
  },
  deleteCloudFile: (cloudFileId) => garmentAssetStorage.delete(cloudFileId),
  now: () => new Date().toISOString(),
  createRequestId: createDefaultRequestId,
});

export async function main(event: unknown): Promise<unknown> {
  return handler(event);
}
