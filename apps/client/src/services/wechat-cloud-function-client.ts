import type {
  WechatCloudRequest,
  WechatCloudSuccessData,
  WechatCloudResponse,
} from "@cloth-idea/domain";

import { GenerationApiError } from "./garment-gateway";

export interface WechatCloudFunctionClient {
  callFunction(options: {
    readonly name: string;
    readonly data: Record<string, unknown>;
  }): Promise<{ readonly result: unknown }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCloudResponse(value: unknown): WechatCloudResponse {
  const payload =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new GenerationApiError("云函数返回了无法识别的结果。", "BAD_CLOUD_RESPONSE", true);
  }
  if (payload.ok === true && isRecord(payload.data)) {
    return payload as unknown as WechatCloudResponse;
  }
  if (
    payload.ok === false &&
    isRecord(payload.error) &&
    typeof payload.error.code === "string" &&
    typeof payload.error.message === "string" &&
    typeof payload.error.requestId === "string" &&
    typeof payload.error.retryable === "boolean"
  ) {
    return payload as unknown as WechatCloudResponse;
  }
  throw new GenerationApiError("云函数返回了无法识别的结果。", "BAD_CLOUD_RESPONSE", true);
}

export async function callGarmentCloudFunction(
  client: WechatCloudFunctionClient,
  request: WechatCloudRequest,
): Promise<WechatCloudSuccessData> {
  let invocation: { readonly result: unknown };
  try {
    invocation = await client.callFunction({
      name: "garment-api",
      data: request as unknown as Record<string, unknown>,
    });
  } catch {
    throw new GenerationApiError(
      "无法连接微信云端服务，请稍后重试。",
      "CLOUD_FUNCTION_UNAVAILABLE",
      true,
    );
  }
  const response = parseCloudResponse(invocation.result);
  if (!response.ok) {
    throw new GenerationApiError(
      response.error.message,
      response.error.code,
      response.error.retryable,
    );
  }
  return response.data;
}
