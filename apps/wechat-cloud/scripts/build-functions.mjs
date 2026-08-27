import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsup";

const workspaceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(workspaceDirectory, "../client/cloudfunctions/garment-api");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entry: { index: resolve(workspaceDirectory, "src/garment-api/index.ts") },
  outDir: outputDirectory,
  format: ["cjs"],
  platform: "node",
  target: "node20",
  bundle: true,
  clean: false,
  sourcemap: false,
  minify: false,
  external: ["wx-server-sdk"],
  outExtension: () => ({ js: ".js" }),
  silent: true,
});

await writeFile(
  resolve(outputDirectory, "package.json"),
  `${JSON.stringify(
    {
      name: "garment-api",
      version: "0.1.0",
      private: true,
      main: "index.js",
      dependencies: { "wx-server-sdk": "4.0.2" },
      overrides: {
        "@cloudbase/database": "1.5.0",
        axios: "1.20.0",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
