import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const apiKey = process.env.ARK_API_KEY;
const model = process.env.ARK_IMAGE_MODEL || "doubao-seedream-5-0-260128";
const imageArg = process.argv[2];
const promptArg = process.argv[3] || "prompts/retro-workwear.txt";

if (!apiKey) {
  throw new Error("缺少 ARK_API_KEY：请在 .env.local 中填写火山方舟 API Key。");
}

if (!imageArg) {
  throw new Error(
    "请提供服装图片路径，例如：npm run test:seedream -- /absolute/path/to/garment.jpg",
  );
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

const response = await fetch(
  "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      image: [`data:image/${mimeSubtype};base64,${imageBytes.toString("base64")}`],
      size: "2K",
      response_format: "url",
      sequential_image_generation: "disabled",
      stream: false,
      watermark: false,
    }),
  },
);

const payload = await response.json();
if (!response.ok) {
  const message = payload?.error?.message || JSON.stringify(payload);
  throw new Error(`Seedream 调用失败（HTTP ${response.status}）：${message}`);
}

const result = payload?.data?.[0];
if (!result) {
  throw new Error(`Seedream 未返回图片：${JSON.stringify(payload)}`);
}

await mkdir("outputs", { recursive: true });
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const outputBase = `seedream-${basename(imagePath, extname(imagePath))}-${timestamp}`;

let outputPath;
if (result.b64_json) {
  outputPath = resolve("outputs", `${outputBase}.png`);
  await writeFile(outputPath, Buffer.from(result.b64_json, "base64"));
} else if (result.url) {
  const imageResponse = await fetch(result.url);
  if (!imageResponse.ok) {
    throw new Error(`图片生成成功，但下载失败（HTTP ${imageResponse.status}）。`);
  }
  const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
  const outputExtension = contentType.includes("png") ? "png" : "jpg";
  outputPath = resolve("outputs", `${outputBase}.${outputExtension}`);
  await writeFile(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
} else {
  throw new Error(`返回结果中没有 url 或 b64_json：${JSON.stringify(result)}`);
}

console.log(`模型：${payload.model || model}`);
console.log(`输出：${outputPath}`);
console.log(`尺寸：${result.size || "未知"}`);
console.log(`用量：${JSON.stringify(payload.usage || {})}`);
