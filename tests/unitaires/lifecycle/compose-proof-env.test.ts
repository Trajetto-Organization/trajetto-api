import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The proof document's signing, map and geocoding settings reach the
 * production container (decision 14.8, design §12).
 *
 * The API service lists its environment one variable at a time and has no
 * env_file: a variable the env schema reads but compose does not forward is
 * silently unset in staging and production. For the A1 certificate that
 * means every receipt goes out unsigned while the operator believes it is
 * configured — nothing errors. So every PROOF_* / REVERSE_GEOCODER_* key the
 * schema declares must appear as `KEY: ${KEY...}` in the api service.
 */
const root = process.cwd();

const compose = readFileSync(resolve(root, "compose.production.yaml"), "utf8");
const envSource = readFileSync(resolve(root, "src/schemas/env-schema/index.ts"), "utf8");

function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:`);
  expect(start, `serviço ${name} não encontrado`).toBeGreaterThan(-1);

  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:\r?\n/);

  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** What Swarm reads: the YAML without its comment lines. */
function withoutComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

const keys = [
  ...new Set(
    [...envSource.matchAll(/^\s+((?:PROOF|REVERSE_GEOCODER)_[A-Z0-9_]+):/gm)].map(
      (match) => match[1],
    ),
  ),
];

describe("the proof settings in compose.production.yaml", () => {
  it("are read from the env schema (the list is not empty)", () => {
    expect(keys).toEqual(
      expect.arrayContaining([
        "PROOF_SIGNING_PFX_BASE64",
        "PROOF_SIGNING_PFX_PATH",
        "PROOF_SIGNING_PFX_PASSWORD",
        "PROOF_ISSUER_CNPJ",
        "PROOF_MAP_TILE_URL",
        "REVERSE_GEOCODER_URL",
      ]),
    );
  });

  it.each(keys)("forwards %s to the api service", (key) => {
    const api = withoutComments(service("api"));

    expect(api).toMatch(new RegExp(String.raw`\n\s+${key}: \$\{${key}(:-[^}]*)?\}`));
  });
});
