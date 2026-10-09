import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { buildLogger } from "@/shared/logging/logger";

/**
 * Defence in depth for the proof document's secrets (design §6.3/§13.3 of
 * the ICP proof). The signing code never logs them; if a future line dumps
 * the environment, or an object built from it, the values are still censored.
 */
const SECRET_ENV_KEYS = [
  "PROOF_SIGNING_PFX_BASE64",
  "PROOF_SIGNING_PFX_PASSWORD",
  "REVERSE_GEOCODER_KEY",
  "PROOF_MAP_TILE_URL",
] as const;

function capture(): { lines: string[]; sink: Writable } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });

  return { lines, sink };
}

describe("the process logger and the proof secrets", () => {
  it.each(SECRET_ENV_KEYS)("censors %s at the top, one and two levels down", (key) => {
    const { lines, sink } = capture();
    const value = `secret-value-of-${key}`;

    const log = buildLogger(sink);

    log.info({ [key]: value }, "top");
    log.info({ env: { [key]: value } }, "nested");
    log.info({ config: { proof: { [key]: value } } }, "deeper");

    expect(lines).toHaveLength(3);

    for (const line of lines) {
      expect(line).not.toContain(value);
      expect(line).toContain("[redacted]");
    }
  });

  it("leaves other fields alone", () => {
    const { lines, sink } = capture();

    buildLogger(sink).info({ env: { PROOF_SIGNATURE_PROFILE: "cms" } }, "profile");

    expect(JSON.parse(lines[0]).env.PROOF_SIGNATURE_PROFILE).toBe("cms");
  });
});
