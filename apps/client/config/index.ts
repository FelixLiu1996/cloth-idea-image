import { resolve } from "node:path";

import { defineConfig, type UserConfigExport, type UserConfigFn } from "@tarojs/cli";

import devConfig from "./dev";
import prodConfig from "./prod";

const createConfig: UserConfigFn<"vite"> = async (merge) => {
  const baseConfig: UserConfigExport<"vite"> = {
    projectName: "cloth-idea-image",
    date: "2026-08-26",
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: "src",
    outputRoot: "dist",
    plugins: [],
    alias: {
      "@tarojs/plugin-framework-react/dist/runtime": resolve(
        __dirname,
        "../node_modules/@tarojs/plugin-framework-react/dist/runtime.js",
      ),
    },
    defineConstants: {
      API_BASE_URL: JSON.stringify(process.env.TARO_APP_API_BASE_URL ?? "http://127.0.0.1:3000"),
    },
    copy: {
      patterns: [],
      options: {},
    },
    framework: "react",
    compiler: "vite",
    mini: {
      postcss: {
        pxtransform: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: "module",
            generateScopedName: "[name]__[local]___[hash:base64:5]",
          },
        },
      },
    },
    h5: {
      publicPath: "/",
      staticDirectory: "static",

      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: "css/[name].[hash].css",
        chunkFilename: "css/[name].[chunkhash].css",
      },
      postcss: {
        autoprefixer: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: "module",
            generateScopedName: "[name]__[local]___[hash:base64:5]",
          },
        },
      },
    },
  };

  if (process.env.NODE_ENV === "development") {
    return merge({}, baseConfig, devConfig);
  }
  return merge({}, baseConfig, prodConfig);
};

export default defineConfig<"vite">(createConfig);
