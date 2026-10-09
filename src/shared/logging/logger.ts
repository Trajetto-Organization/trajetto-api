import { hostname } from "node:os";

import pino, { type DestinationStream, type Logger } from "pino";

import { env } from "@/env";

/**
 * Environment variables whose values must never reach a log line: every
 * credential, signing key and secret-bearing URL the env schema declares.
 * A line that dumps the environment, or a config object built from it, is
 * censored by name (tests/unitaires/logging/secret-env-redaction.test.ts
 * keeps this list in step with the schema).
 */
const SECRET_ENV_KEYS = [
  "PROOF_SIGNING_PFX_BASE64",
  "PROOF_SIGNING_PFX_PASSWORD",
  "REVERSE_GEOCODER_KEY",
  // A tile URL can carry the provider's API key in its query string.
  "PROOF_MAP_TILE_URL",
  // Connection strings carry the password.
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "JWT_SECRET_REFRESH_TOKEN",
  "META_WHATSAPP_ACCESS_TOKEN",
  "META_WHATSAPP_APP_SECRET",
  "META_WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "RESEND_SECRET_KEY",
  "RESEND_WEBHOOK_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "AI_LOCAL_TOKEN",
  // Whoever holds the check's URL can silence the alert.
  "HEALTHCHECK_PING_URL",
  "HEALTHCHECK_FAIL_URL",
  "MASTER_USER_INITIAL_PASSWORD",
  "DOCS_PASSWORD",
  "TURNSTILE_SECRET_KEY",
  "RATE_LIMIT_FORWARDER_SECRET",
  "RATE_LIMIT_EDGE_SECRET",
  "SOCKET_ADAPTER_KEY",
  "WEBHOOK_SECRETS_KEY",
] as const;

/**
 * Field names that are a credential wherever they appear: a body, a user or
 * a provider answer logged whole. Top level and one level down.
 */
const SECRET_FIELD_NAMES = [
  "password",
  "newPassword",
  "currentPassword",
  "refresh_token",
  "refreshToken",
  "access_token",
  "accessToken",
] as const;

/**
 * The one logger of the process: Fastify's request lines and every worker
 * write through it (OBS-06, OBS-14).
 *
 * The workers used to write `console.*` free text between the JSON lines
 * Fastify wrote, so the same stdout was two formats and neither could be
 * filtered by tenant, event or delivery. One pino root means one format and
 * one level — LOG_LEVEL — for all of it; a worker takes a child with its
 * `component`, and each line carries the ids that identify what it is about.
 *
 * `destination` exists for tests, which read what a line actually says.
 */
function buildLogger(destination?: DestinationStream): Logger {
  return pino(
    {
      level: env.LOG_LEVEL,

      // pino's own bindings plus the environment (ENV-1): staging and
      // production run the same image, and a line has to say which one wrote
      // it. Setting `base` replaces the defaults, so pid and hostname are
      // spelled out.
      base: { pid: process.pid, hostname: hostname(), app_env: env.APP_ENV },

      // No serializer writes headers today; this is the floor under the next
      // one that does. A bearer token or a session cookie in a log is a
      // session anybody with log access can replay.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "headers.authorization",
          "headers.cookie",
          ...SECRET_FIELD_NAMES.flatMap((key) => [key, `*.${key}`]),
          // The proof document's secrets (design §6.3 of the ICP proof): the
          // signing code never logs them; this catches a line that dumps the
          // environment or a config built from it, up to two levels down.
          ...SECRET_ENV_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}

const logger = buildLogger();

export { SECRET_ENV_KEYS, SECRET_FIELD_NAMES, buildLogger, logger };
