import { defineConfig } from "tsup";
import { globSync } from "glob";

import { promises as fs } from "node:fs";
import path from "node:path";

export default defineConfig({
  entry: {
    server: "./src/server.ts",
    seed: "./infra/scripts/seed.ts",
    "workers/email-worker": "./src/workers/email-worker.ts",
    "workers/whatsapp-worker": "./src/workers/whatsapp-worker.ts",
    "workers/ai-verification-worker": "./src/workers/ai-verification-worker.ts",
    "import-violation-codes": "./infra/scripts/import-violation-codes.ts",
    "seed-whatsapp-instance": "./infra/scripts/seed-whatsapp-instance.ts",
  },
  format: ["cjs"],
  target: "es2020",
  outDir: "./build",
  sourcemap: false,
  clean: true,
  minify: false,
  splitting: false,
  skipNodeModulesBundle: true,
  banner: { js: '"use strict";require("reflect-metadata");' },
  loader: {
    ".hbs": "copy",
    ".html": "copy",
    ".json": "copy",
  },
  async onSuccess() {
    try {
      console.log("Copiando templates de email...");
      const viewDirs = globSync("src/modules/*/views", { cwd: process.cwd() });

      for (const viewDir of viewDirs) {
        await fs.cp(viewDir, path.join("build", viewDir), { recursive: true });
      }

      console.log("Build completed successfully!");
    } catch (error) {
      console.error("Erro ao copiar assets:", error);
      process.exit(1);
    }
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV || "production",
    ),
  },
  outExtension() {
    return { js: `.js` };
  },
});
