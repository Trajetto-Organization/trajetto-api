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

  // Packages that must NOT be bundled (native bindings, DI, or complex runtime)
  // Node built-in modules (fs, path, crypto, etc.) are automatically external
  external: [
    "@prisma/client",
    "prisma",
    "bcrypt",
    "jsonwebtoken",
    "nodemailer",
    "handlebars",
    "amqplib",
    "socket.io",
    "fastify",
    "sharp",
    "tsyringe",
    "reflect-metadata",
  ],

  loader: {
    ".hbs": "copy",
    ".html": "copy",
    ".json": "copy",
    ".xlsx": "copy",
  },

  async onSuccess() {
    try {
      async function copyRecursive(src: string, dest: string) {
        const stat = await fs.stat(src);

        if (stat.isDirectory()) {
          await fs.mkdir(dest, { recursive: true });
          const entries = await fs.readdir(src);

          for (const entry of entries) {
            await copyRecursive(path.join(src, entry), path.join(dest, entry));
          }
        } else {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(src, dest);
        }
      }

      // Copy email templates (handlebars views used at runtime)
      console.log("Copiando templates de email...");
      const viewDirs = globSync("src/modules/*/views", { cwd: process.cwd() });

      for (const viewDir of viewDirs) {
        const targetDir = path.join("build", viewDir);
        await copyRecursive(viewDir, targetDir);
      }

      // Fix DI order: ensure reflect-metadata loads before tsyringe in all entry points
      const entryFiles = globSync("build/**/*.js");
      for (const file of entryFiles) {
        let content = await fs.readFile(file, "utf8");

        content = content.replace(
          /require\(['"]reflect-metadata['"]\);?\s*\n?/g,
          "",
        );
        content = content.replace(
          /(['"])use strict\1;\s*\n/,
          `$&require('reflect-metadata');\n`,
        );

        await fs.writeFile(file, content, "utf8");
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
  treeshake: true,
  outExtension({ format }) {
    return { js: `.js` };
  },
});
