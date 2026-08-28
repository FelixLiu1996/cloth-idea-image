import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const requiredArtifacts = [
  ["H5", "apps/client/dist/h5/index.html"],
  ["微信小程序", "apps/client/dist/weapp/app.json"],
];

const missingArtifacts = [];

for (const [platform, relativePath] of requiredArtifacts) {
  try {
    await access(resolve(relativePath), constants.R_OK);
  } catch {
    missingArtifacts.push(`${platform}: ${relativePath}`);
  }
}

if (missingArtifacts.length > 0) {
  console.error(`客户端构建产物不完整：\n${missingArtifacts.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("客户端双端构建产物检查通过：H5 index.html、微信小程序 app.json。");
}
