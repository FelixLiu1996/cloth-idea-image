import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GarmentGenerationResult, GenerationApiResponse } from "@cloth-idea/domain";
import type { GarmentImageProvider } from "@cloth-idea/model-providers";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app";
import type { ServerConfig } from "./config";

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

class FakeProvider implements GarmentImageProvider {
  readonly provider = "alibaba-wan" as const;
  readonly model = "fake-wan";
  readonly configured = true;
  readonly generateVariation = vi.fn(async (): Promise<GarmentGenerationResult> => ({
    provider: this.provider,
    model: this.model,
    providerRequestId: "provider-request-1",
    durationMs: 1_250,
    assets: [{ bytes: pngBytes, mimeType: "image/png" }],
    usage: {
      generatedImages: 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      size: "2K",
    },
  }));
}

async function createMultipartRequest(includeImage = true) {
  const form = new FormData();
  form.append("mode", "quick-derivative");
  form.append("preserveItems", "黑白格纹袖口, 深蓝牛仔面料");
  form.append("changeRequest", "改成复古工装短夹克并重做整体结构");
  form.append("styleDirection", "九十年代日系复古工装");
  form.append("intensity", "medium");
  if (includeImage) {
    form.append("sourceImage", new Blob([pngBytes], { type: "image/png" }), "jacket.png");
  }

  const request = new Request("http://localhost", { method: "POST", body: form });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    headers: {
      "content-type": request.headers.get("content-type") ?? "multipart/form-data",
      "idempotency-key": "same-request",
    },
  };
}

async function createTestContext() {
  const assetDirectory = await mkdtemp(join(tmpdir(), "cloth-idea-server-"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://example.test",
    clientOrigin: "*",
    assetDirectory,
    maxUploadBytes: 10 * 1024 * 1024,
  };
  const provider = new FakeProvider();
  const app = await buildApp({ config, provider });
  return { app, assetDirectory, provider };
}

describe("generation API", () => {
  it("reports provider readiness", async () => {
    const context = await createTestContext();
    try {
      const response = await context.app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "ok",
        model: "fake-wan",
        providerConfigured: true,
      });
    } finally {
      await context.app.close();
      await rm(context.assetDirectory, { recursive: true, force: true });
    }
  });

  it("generates and serves a redesigned garment", async () => {
    const context = await createTestContext();
    try {
      const multipartRequest = await createMultipartRequest();
      const response = await context.app.inject({
        method: "POST",
        url: "/api/v1/generations",
        ...multipartRequest,
      });

      expect(response.statusCode).toBe(201);
      const result = response.json<GenerationApiResponse>();
      expect(result).toMatchObject({
        status: "succeeded",
        provider: "alibaba-wan",
        model: "fake-wan",
      });
      expect(result.summary).toContain("黑白格纹袖口");
      expect(context.provider.generateVariation).toHaveBeenCalledTimes(1);

      const assetResponse = await context.app.inject({
        method: "GET",
        url: new URL(result.resultUrl).pathname,
      });
      expect(assetResponse.statusCode).toBe(200);
      expect(assetResponse.headers["content-type"]).toContain("image/png");
      expect(assetResponse.rawPayload).toEqual(Buffer.from(pngBytes));

      const repeatedResponse = await context.app.inject({
        method: "POST",
        url: "/api/v1/generations",
        ...(await createMultipartRequest()),
      });
      expect(repeatedResponse.statusCode).toBe(200);
      expect(repeatedResponse.json<GenerationApiResponse>().jobId).toBe(result.jobId);
      expect(context.provider.generateVariation).toHaveBeenCalledTimes(1);
    } finally {
      await context.app.close();
      await rm(context.assetDirectory, { recursive: true, force: true });
    }
  });

  it("returns a stable error when the source image is missing", async () => {
    const context = await createTestContext();
    try {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/v1/generations",
        ...(await createMultipartRequest(false)),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "IMAGE_REQUIRED",
        retryable: false,
      });
    } finally {
      await context.app.close();
      await rm(context.assetDirectory, { recursive: true, force: true });
    }
  });
});
