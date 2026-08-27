import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const apiKey = process.env.DASHSCOPE_API_KEY;
const baseUrl = process.env.DASHSCOPE_API_BASE_URL?.replace(/\/$/, "");
const model = process.env.DASHSCOPE_WAN_MODEL || "wan2.7-image-pro";
const imageArg = process.argv[2];
const promptArg = process.argv[3] || "prompts/retro-workwear.txt";

if (!apiKey) {
  throw new Error("缺少 DASHSCOPE_API_KEY：请在 .env.local 中填写百炼 API Key。");
}

if (!baseUrl) {
  throw new Error("缺少 DASHSCOPE_API_BASE_URL：请填写北京地域的业务空间 API Host。");
}

if (!imageArg) {
  throw new Error("请提供服装图片路径，例如：npm run test:wan -- /absolute/path/to/garment.jpg");
}

const imagePath = resolve(imageArg);
const promptPath = resolve(promptArg);
const imageBytes = await readFile(imagePath);
const prompt = (await readFile(promptPath, "utf8")).trim();
const extension = extname(imagePath).slice(1).toLowerCase();
const mimeSubtype = extension === "jpg" ? "jpeg" : extension;

if (!new Set(["jpeg", "png", "webp"]).has(mimeSubtype)) {
  throw new Error("输入图片仅支持 JPG、PNG 或 WEBP。");
}

const response = await fetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    input: {
      messages: [
        {
          role: "user",
          content: [
            { text: prompt },
            {
              image: `data:image/${mimeSubtype};base64,${imageBytes.toString("base64")}`,
            },
          ],
        },
      ],
    },
    parameters: {
      size: "2K",
      n: 1,
      watermark: false,
      enable_interleave: false,
      prompt_extend: true,
    },
  }),
});

const payload = await response.json();
if (!response.ok || payload.code) {
  const message = payload.message || payload.code || JSON.stringify(payload);
  throw new Error(`万相调用失败（HTTP ${response.status}）：${message}`);
}

const contents =
  payload?.output?.choices?.flatMap((choice) => choice?.message?.content || []) || [];
const imageResult = contents.find((content) => content.type === "image" && content.image);

if (!imageResult) {
  throw new Error(`万相未返回图片：${JSON.stringify(payload)}`);
}

const imageResponse = await fetch(imageResult.image);
if (!imageResponse.ok) {
  throw new Error(`图片生成成功，但下载失败（HTTP ${imageResponse.status}）。`);
}

await mkdir("outputs", { recursive: true });
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const outputPath = resolve(
  "outputs",
  `wan-${basename(imagePath, extname(imagePath))}-${timestamp}.png`,
);
await writeFile(outputPath, Buffer.from(await imageResponse.arrayBuffer()));

console.log(`模型：${model}`);
console.log(`输出：${outputPath}`);
console.log(`用量：${JSON.stringify(payload.usage || {})}`);
console.log(`请求 ID：${payload.request_id || payload.requestId || "未知"}`);
