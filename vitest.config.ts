import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@cloth-idea/domain": resolve(import.meta.dirname, "packages/domain/src/index.ts"),
      "@cloth-idea/model-providers": resolve(
        import.meta.dirname,
        "packages/model-providers/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
