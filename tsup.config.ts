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
    // The release step's online DDL (prisma/concurrent), before `migrate
    // deploy`. Moved to release/ with the seeds: only the release image
    // runs it.
    "prebuild-online-ddl": "./infra/scripts/prebuild-online-ddl.ts",
    // The steps right after it (infra/sql, prisma/post-deploy), with their
    // state in release_step_state. Release image only, as above.
    "release-steps": "./infra/scripts/release-steps.ts",
    // Run once in the production container after WEBHOOK_SECRETS_KEY is
    // set: seals the webhook credentials written before it.
    "seal-webhook-secrets": "./infra/scripts/seal-webhook-secrets.ts",
    // Run once in the production container after the address key's
    // migration (14/11/2026): keys the deliveries written before it and
    // gives each door's point to its open deliveries still without one.
    "backfill-delivery-address-key":
      "./infra/scripts/backfill-delivery-address-key.ts",
    // The receipt renderer's worker thread. proof-pdf-renderer.ts loads it
    // from next to server.js (build/proof-pdf-worker.js) by this name.
    "proof-pdf-worker": "./src/shared/services/proof-pdf-worker.ts",
    // The spreadsheet reader's worker thread (plano-escala F3-23b).
    // spreadsheet-worker.ts loads it from next to server.js
    // (build/spreadsheet-read-worker.js) by this name.
    "spreadsheet-read-worker":
      "./src/modules/import/services/spreadsheet-read-worker.ts",
    // The CPU pool's worker thread (plano-escala F3-29): the NF-e parse and
    // the Excel export's workbook. cpu-pool.ts loads it from next to
    // server.js (build/cpu-pool-worker.js) by this name.
    "cpu-pool-worker": "./src/shared/cpu-pool/cpu-pool-worker.ts",
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

      // Every migration this build was written against. A replica's boot
      // refuses a database that lacks any of them
      // (infra/scripts/schema-guard.ts): the API image carries no
      // migrations, only their names.
      const migrations = (
        await fs.readdir("prisma/migrations", { withFileTypes: true })
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

      if (migrations.length === 0) {
        throw new Error("prisma/migrations está vazio");
      }

      await fs.writeFile(
        path.join("build", "schema-version.json"),
        `${JSON.stringify({ migrations })}\n`,
      );

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
