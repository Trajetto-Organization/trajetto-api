import { defineConfig } from "tsup";
import { globSync } from "glob";

import { promises as fs } from "node:fs";
import path from "node:path";

export default defineConfig({
  entry: {
    server: "./src/server.ts",
    seed: "./infra/scripts/seed.ts",
    "import-violation-codes": "./infra/scripts/import-violation-codes.ts",
    // Compiled because it runs in the production image, where tsx does not
    // exist — only production dependencies are installed there.
    "wait-for-postgres": "./infra/scripts/wait-for-postgres.ts",
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
