import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { format, resolveConfig } from "prettier";

import { renderMonitoringFiles } from "../monitoring/monitoring-config";

/**
 * `yarn monitoring:render` writes the metrics stack's files (plano-escala
 * F5-30) from infra/monitoring/monitoring-config.ts; with `--check` it
 * only says which ones are out of date. The output goes through the
 * repository's Prettier, so `yarn lint:check` and the generated files
 * never disagree. A command-line tool, so it prints to the terminal
 * (tests/unitaires/logging/no-console.test.ts exempts infra/scripts).
 */
const ROOT = resolve(__dirname, "..", "..");

async function formatted(path: string, text: string): Promise<string> {
  const absolute = resolve(ROOT, path);
  const options = (await resolveConfig(absolute)) ?? {};

  return format(text, { ...options, filepath: absolute });
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const stale: string[] = [];

  for (const [path, text] of Object.entries(renderMonitoringFiles())) {
    const wanted = await formatted(path, text);
    const absolute = resolve(ROOT, path);
    let current: string | null = null;

    try {
      current = readFileSync(absolute, "utf8").replace(/\r\n/g, "\n");
    } catch {
      current = null;
    }

    if (current === wanted) continue;

    stale.push(path);

    if (!check) {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, wanted);
    }
  }

  if (check && stale.length > 0) {
    console.error(
      `[monitoring:render] desatualizados (rode yarn monitoring:render): ${stale.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    stale.length === 0
      ? "[monitoring:render] nada mudou"
      : `[monitoring:render] escritos: ${stale.join(", ")}`,
  );
}

main().catch((error) => {
  console.error("[monitoring:render] Falhou:", error);
  process.exitCode = 1;
});
