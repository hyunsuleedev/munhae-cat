import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

const rendererRoot = resolve(__dirname, "src/renderer");

const munhaePackages = [
  "@munhae/domain",
  "@munhae/db-sqlite",
  "@munhae/project-format",
  "@munhae/agent-runtime",
];

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: munhaePackages,
        include: ["better-sqlite3"],
      }),
    ],
    build: {
      lib: {
        entry: {
          index: resolve(__dirname, "src/main/index.ts"),
          "agent-runtime-worker": resolve(__dirname, "src/main/agent-runtime-worker.ts"),
          "agent-tool-cli": resolve(__dirname, "src/main/agent-tool-cli.ts"),
        },
      },
      rollupOptions: {
        external: ["better-sqlite3"],
        output: { entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    // Sandboxed preload cannot load ESM; emit CJS so contextBridge works with sandbox: true.
    build: {
      lib: { entry: resolve(__dirname, "src/preload/index.ts") },
      rollupOptions: {
        output: {
          format: "cjs",
          inlineDynamicImports: true,
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    root: rendererRoot,
    base: "./",
    server: {
      proxy: {
        "/__munhae": {
          target: "http://127.0.0.1:17321",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/__munhae/, ""),
        },
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(rendererRoot, "index.html"),
          home: resolve(rendererRoot, "home.html"),
          editor: resolve(rendererRoot, "editor.html"),
          knowledge: resolve(rendererRoot, "knowledge.html"),
          context: resolve(rendererRoot, "context.html"),
          settings: resolve(rendererRoot, "settings.html"),
          account: resolve(rendererRoot, "account.html"),
        },
      },
    },
  },
});
