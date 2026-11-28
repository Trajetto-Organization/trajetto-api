import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { ZodPipe, type core } from "zod";

import { envSchema } from "@/schemas/env-schema";

import { API_ROOT, DEFAULT_REDIS_URL, simDatabaseUrl } from "./sim-config";

/**
 * The environment of the simulated replicas, written to a file of its own.
 *
 * Built from the KEYS of .env.example and of the env schema, never from the
 * developer's .env (which holds real secrets and is never read here). Every
 * key is written, the optional ones empty; empty counts as absent in the
 * schema (definedEnv). That alone would NOT keep the .env out: src/env runs
 * dotenv from the working directory, and dotenv-expand then copies the
 * file's value over every variable that is set but empty. So the replicas
 * also run with no-env-file.cjs preloaded (guarded-node.ts), and to them the
 * file does not exist.
 *
 * The JWT secrets are random and kept in the file, so a restart of the
 * replicas keeps the sessions of a simulation in progress valid.
 */

/** Keys of `KEY=value` and `# KEY=value` lines. */
function exampleKeys(text: string): string[] {
  const keys = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);

    if (match) keys.add(match[1]);
  }

  return [...keys];
}

/** Every key the API's env schema reads. */
function schemaKeys(): string[] {
  let schema: core.$ZodType = envSchema;

  // zod 4: the refinements live on the object; each transform is a pipe.
  while (schema instanceof ZodPipe) schema = schema.in;

  const shape = (schema as unknown as { shape?: Record<string, unknown> })
    .shape;

  return shape ? Object.keys(shape) : [];
}

function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);

    if (match) values[match[1]] = match[2];
  }

  return values;
}

interface SimEnvOptions {
  /** Replica A's URL: absolute links (proof_url, local uploads) use it. */
  apiUrl: string;

  /** Where the web runs (CORS, links in e-mails nobody sends here). */
  webUrl: string;
}

/**
 * The values. Throwaway, local, and with every outbound integration off:
 * no AI (the trajetto-ai container is never called), no geocoder, no map
 * tiles, no WhatsApp, no e-mail, no push token on Expo, no health pings.
 */
function simEnvValues(
  options: SimEnvOptions,
  previous: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const secret = (key: string) =>
    previous[key] && previous[key].length >= 32
      ? previous[key]
      : randomBytes(48).toString("base64url");

  return {
    // "test", not "development": e-mail goes to the in-process inbox (development
    // sends it to Ethereal, off this machine) and Prisma does not log every
    // query. Nothing else in the API branches on it outside production.
    NODE_ENV: "test",
    APP_ENV: "development",
    LOG_LEVEL: env.SIM_API_LOG_LEVEL || "warn",
    DATABASE_URL: simDatabaseUrl(env),
    REDIS_URL: env.SIM_REDIS_URL || DEFAULT_REDIS_URL,
    HTTP_REQUEST: options.webUrl,
    API_HTTP_REQUEST: options.apiUrl,
    JWT_SECRET: secret("JWT_SECRET"),
    JWT_SECRET_REFRESH_TOKEN: secret("JWT_SECRET_REFRESH_TOKEN"),
    MASTER_USER_EMAIL: "master@simulacao.invalid",
    MASTER_USER_INITIAL_PASSWORD: secret("MASTER_USER_INITIAL_PASSWORD"),
    AI_PROVIDER: "none",
    UPLOAD_STORAGE_TYPE: "local",
    // The API's own development folder: its static /tmp/ route serves it, so
    // the web shows the simulated photos. The orphan collector stays off, so
    // a simulated replica never touches the files the developer keeps there.
    UPLOAD_LOCAL_PATH: "./tmp",
    UPLOAD_ORPHAN_GC: "off",
    RATE_LIMIT_TRUSTED_PROXY: "none",
    // Pub/Sub ignores the Redis database number: this prefix is what keeps
    // the simulated replicas' realtime apart from an E2E run on the same
    // Redis.
    SOCKET_ADAPTER_KEY: "trajetto-sim",
    // Each replica runs its own workers and cron, leases included.
    WORKERS_ENABLED: "true",
    DELIVERY_GEOCODING_DAILY_BUDGET: "0",
  };
}

/**
 * Writes (or refreshes) the env file and returns its values. Keys absent
 * from the values map are written empty.
 */
function writeSimEnvFile(
  path: string,
  options: SimEnvOptions,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const example = readFileSync(resolve(API_ROOT, ".env.example"), "utf8");
  const keys = [...new Set([...exampleKeys(example), ...schemaKeys()])];
  const previous = existsSync(path)
    ? parseEnvFile(readFileSync(path, "utf8"))
    : {};
  const values = simEnvValues(options, previous, env);

  const all: Record<string, string> = {};

  for (const key of keys) all[key] = values[key] ?? "";
  for (const [key, value] of Object.entries(values)) all[key] = value;

  // PORT is per replica (start-replicas.ts); here it would be misleading.
  delete all.PORT;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "# Gerado por tests/simulation/scripts/start-replicas.ts. Valores descartáveis.",
      "# Nunca copiado do .env: as chaves vêm do .env.example e do env-schema.",
      ...Object.entries(all).map(([key, value]) => `${key}=${value}`),
      "",
    ].join("\n"),
  );

  return all;
}

export { exampleKeys, parseEnvFile, schemaKeys, simEnvValues, writeSimEnvFile };
export type { SimEnvOptions };
