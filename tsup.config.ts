import { defineConfig } from "tsup";
import { globSync } from "glob";

import { promises as fs } from "node:fs";
import path from "node:path";

export default defineConfig({
  // Main entry points
  entry: {
    server: "./src/server.ts",
    seed: "./infra/scripts/seed.ts",
    // Workers need to be built separately
    "workers/email-worker": "./src/workers/email-worker.ts",
    "workers/whatsapp-worker": "./src/workers/whatsapp-worker.ts",
    "import-violation-codes": "./infra/scripts/import-violation-codes.ts",
  },

  // Output Formats
  format: ["cjs"],
  target: "es2020",

  // Output directory
  outDir: "./build",

  // Build Settings
  sourcemap: false, // Disable in production to reduce size
  clean: true,
  minify: false, // Keep it readable for debugging in production

  // Splitting for optimization
  splitting: false,

  // External dependencies (do not bundle)
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
    // Other native Node.js modules
    "crypto",
    "fs",
    "path",
    "http",
    "https",
    "url",
    "querystring",
    "stream",
    "util",
    "events",
    "buffer",
    "os",
    "child_process",
    "worker_threads",
    "cluster",
    "net",
    "tls",
    "dgram",
    "dns",
    "readline",
    "repl",
    "vm",
    "zlib",
  ],

  // Settings for different file types
  loader: {
    ".hbs": "copy", // Handlebars Templates
    ".html": "copy", // HTML Templates
    ".json": "copy", // JSON files
    ".xlsx": "copy", // Excel Files
  },

  // Hook to copy additional assets - CROSS-PLATFORM VERSION
  async onSuccess() {
    try {
      // Helper function to create directories recursively
      async function ensureDir(dirPath: string) {
        try {
          await fs.mkdir(dirPath, { recursive: true });
        } catch (error: any) {
          if (error.code !== "EEXIST") {
            throw error;
          }
        }
      }

      // Helper function to copy files/directories recursively
      async function copyRecursive(src: string, dest: string) {
        const stat = await fs.stat(src);

        if (stat.isDirectory()) {
          await ensureDir(dest);
          const entries = await fs.readdir(src);

          for (const entry of entries) {
            const srcPath = path.join(src, entry);
            const destPath = path.join(dest, entry);
            await copyRecursive(srcPath, destPath);
          }
        } else {
          await ensureDir(path.dirname(dest));
          await fs.copyFile(src, dest);
        }
      }

      // Copy email templates
      console.log("📁 Copiando templates de email...");

      // Create target directory
      await ensureDir("build/src/modules");

      // Find all views directories
      const viewDirs = globSync("src/modules/*/views", { cwd: process.cwd() });

      for (const viewDir of viewDirs) {
        const targetDir = path.join("build", viewDir);

        // Ensure parent directory exists
        await ensureDir(path.dirname(targetDir));

        // Copy the views directory
        await copyRecursive(viewDir, targetDir);

        console.log(`✅ Copiado: ${viewDir} -> ${targetDir}`);
      }

      // Copy Prisma schema
      console.log("📁 Copiando schema do Prisma...");

      await ensureDir("build/prisma");
      await fs.copyFile("prisma/schema.prisma", "build/prisma/schema.prisma");

      // ✅ COPY EXCEL FILE FOR VIOLATIONS IMPORT
      console.log("📁 Copiando arquivo Excel de infrações...");

      const excelSourcePath = "tabela-codigo-infracoes-renainf-xlsx.xlsx";
      const excelTargetPath = "build/tabela-codigo-infracoes-renainf-xlsx.xlsx";

      try {
        await fs.access(excelSourcePath); // Check if file exists
        await fs.copyFile(excelSourcePath, excelTargetPath);
        console.log(
          `✅ Arquivo Excel copiado: ${excelSourcePath} -> ${excelTargetPath}`,
        );
      } catch (error) {
        console.warn(`⚠️  Arquivo Excel não encontrado: ${excelSourcePath}`);
        console.warn(
          "   O seed de infrações pode falhar se o arquivo não estiver presente.",
        );
      }

      console.log("✅ Build completed successfully!");
    } catch (error) {
      console.error("❌ Erro ao copiar assets:", error);
      process.exit(1);
    }
  },

  // Specific configurations for development/production
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV || "production",
    ),
  },

  // Tree-shaking
  treeshake: true,

  // Output Settings
  outExtension({ format }) {
    return {
      js: `.js`,
    };
  },
});
