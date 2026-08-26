import type { GarmentImageProviderInput } from "@cloth-idea/domain";
import { describe, expect, it, vi } from "vitest";

import { AlibabaQwenImageProvider } from "./alibaba-qwen-image-provider";

const input: GarmentImageProviderInput = {
  sourceImage: {
    bytes: new Uint8Array([1, 2, 3]),
    fileName: "coat.jpg",
    mimeType: "image/jpeg",
  },
  prompt: "必须保留不对称门襟，改成现代东方通勤外套",
  outputCount: 1,
  promptVersion: "garment-analysis-v1",
};

describe("AlibabaQwenImageProvider", () => {
  it("edits the reference image, removes source text and downloads the result", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: {
                    content: [{ image: "https://example.com/qwen-result.png" }],
                  },
                },
              ],
            },
            usage: { image_count: 1, width: 1024, height: 1536 },
            request_id: "qwen-image-request-1",
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
    const provider = new AlibabaQwenImageProvider({
      apiKey: "test-api-key",
      baseUrl: "https://workspace.example.com/api/v1/",
      fetchImplementation,
    });

    const result = await provider.generateVariation(input);
    const generationRequest = fetchImplementation.mock.calls[0];
    const requestBody = JSON.parse(String(generationRequest?.[1]?.body)) as {
      model: string;
      input: {
        messages: Array<{ content: Array<{ text?: string; image?: string }> }>;
      };
      parameters: {
        n: number;
        negative_prompt: string;
        prompt_extend: boolean;
        watermark: boolean;
        size?: string;
      };
    };

    expect(generationRequest?.[0]).toBe(
      "https://workspace.example.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(requestBody.model).toBe("qwen-image-2.0-pro-2026-06-22");
    expect(requestBody.input.messages[0]?.content[0]?.image).toMatch(/^data:image\/jpeg;base64,/);
    expect(requestBody.input.messages[0]?.content[1]?.text).toContain("必须从结果中完全删除");
    expect(requestBody.parameters).toMatchObject({
      n: 1,
      prompt_extend: false,
      watermark: false,
    });
    expect(requestBody.parameters.negative_prompt).toContain("商家型号");
    expect(requestBody.parameters.size).toBeUndefined();
    expect(result.provider).toBe("alibaba-qwen-image");
    expect(result.providerRequestId).toBe("qwen-image-request-1");
    expect(result.assets[0]?.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(result.usage.size).toBe("1024*1536");
  });
});
