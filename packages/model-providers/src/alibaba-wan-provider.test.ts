import type { GarmentImageProviderInput } from "@cloth-idea/domain";
import { describe, expect, it, vi } from "vitest";

import { AlibabaWanProvider } from "./alibaba-wan-provider";

const input: GarmentImageProviderInput = {
  sourceImage: {
    bytes: new Uint8Array([1, 2, 3]),
    fileName: "coat.jpg",
    mimeType: "image/jpeg",
  },
  prompt: "必须保留格纹袖口，改成复古工装夹克",
  outputCount: 1,
  promptVersion: "garment-redesign-v1",
};

describe("AlibabaWanProvider", () => {
  it("normalizes the provider response and downloads the generated image", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ type: "image", image: "https://example.com/result.png" }],
                  },
                },
              ],
            },
            usage: { image_count: 1, size: "1883*2226" },
            request_id: "request-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );

    const provider = new AlibabaWanProvider({
      apiKey: "test-api-key",
      baseUrl: "https://workspace.example.com/api/v1/",
      fetchImplementation,
    });

    const result = await provider.generateVariation({
      ...input,
      referenceImages: [
        {
          bytes: new Uint8Array([4, 5, 6]),
          fileName: "stable-anchor.png",
          mimeType: "image/png",
        },
      ],
    });
    const generationRequest = fetchImplementation.mock.calls[0];
    const requestBody = JSON.parse(String(generationRequest?.[1]?.body)) as {
      input: { messages: Array<{ content: Array<{ text?: string; image?: string }> }> };
      parameters: { n: number };
    };

    expect(generationRequest?.[0]).toBe(
      "https://workspace.example.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(requestBody.parameters.n).toBe(1);
    expect(requestBody.input.messages[0]?.content[0]?.text).toContain("格纹袖口");
    expect(requestBody.input.messages[0]?.content[1]?.image).toMatch(/^data:image\/png;base64,/);
    expect(requestBody.input.messages[0]?.content[2]?.image).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.providerRequestId).toBe("request-123");
    expect(result.assets[0]?.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(result.usage.size).toBe("1883*2226");
  });
});
