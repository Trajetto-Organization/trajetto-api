import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { SECRET_ENV_KEYS, buildLogger } from "@/shared/logging/logger";

/**
 * Structured logs without secrets (contract §32). The redaction list named
 * only the proof document's secrets; a line dumping the environment, or a
 * provider config built from it, printed the Resend key, the Meta token, the
 * R2 secret, the OCR token, the database password and the heartbeat URL
 * (whoever holds it can silence the alert) in clear.
 */
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

const PROVIDER_SECRETS = [
  "RESEND_SECRET_KEY",
  "RESEND_WEBHOOK_SECRET",
  "META_WHATSAPP_ACCESS_TOKEN",
  "META_WHATSAPP_APP_SECRET",
  "R2_SECRET_ACCESS_KEY",
  "AI_LOCAL_TOKEN",
  "DATABASE_URL",
  "JWT_SECRET",
  "HEALTHCHECK_PING_URL",
  "WEBHOOK_SECRETS_KEY",
] as const;

describe("the process logger and the provider credentials", () => {
  it.each(PROVIDER_SECRETS)("censors %s at the top, one and two levels down", (key) => {
    const { lines, sink } = capture();
    const value = `secret-value-of-${key}`;
    const log = buildLogger(sink);

    log.info({ [key]: value }, "top");
    log.info({ env: { [key]: value } }, "nested");
    log.info({ config: { provider: { [key]: value } } }, "deeper");

    expect(lines).toHaveLength(3);

    for (const line of lines) {
      expect(line).not.toContain(value);
      expect(line).toContain("[redacted]");
    }
  });

  it.each(["password", "refresh_token", "accessToken"])(
    "censors a %s field logged with a body or a user",
    (field) => {
      const { lines, sink } = capture();

      buildLogger(sink).info({ body: { [field]: "hunter2-secret" } }, "body");

      expect(lines[0]).not.toContain("hunter2-secret");
    },
  );

  it("keeps the list in step with every secret the env schema declares", () => {
    const schema = readFileSync(
      resolve(__dirname, "../../../src/schemas/env-schema/index.ts"),
      "utf8",
    );

    const declared = [...schema.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map(
      (match) => match[1],
    );

    // Names that look like a secret and are not one.
    const notSecret = new Set(["REVERSE_GEOCODER_KEY_PARAM"]);

    const secretLooking = declared.filter(
      (key) =>
        !notSecret.has(key) &&
        /(SECRET|TOKEN|PASSWORD|PFX_BASE64|_KEY$|_KEY_ID$|DATABASE_URL|REDIS_URL|HEALTHCHECK_.*_URL)/.test(
          key,
        ),
    );

    expect(secretLooking.length).toBeGreaterThan(10);

    const missing = secretLooking.filter(
      (key) => !(SECRET_ENV_KEYS as readonly string[]).includes(key),
    );

    expect(missing).toEqual([]);
  });

  it("leaves ordinary fields alone", () => {
    const { lines, sink } = capture();

    buildLogger(sink).info({ env: { RESEND_FROM_EMAIL_DOMAIN: "trajetto.com.br" } }, "x");

    expect(JSON.parse(lines[0]).env.RESEND_FROM_EMAIL_DOMAIN).toBe("trajetto.com.br");
  });
});
