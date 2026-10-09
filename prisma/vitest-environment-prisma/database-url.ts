import * as dotenv from "dotenv";
import * as dotenvExpand from "dotenv-expand";

/**
 * The connection the integration environment derives every per-file database
 * from.
 *
 * `.env` writes DATABASE_URL with `${POSTGRES_HOST}`-style placeholders, which
 * the app expands through dotenv-expand (src/env). The environment used to
 * load plain `dotenv/config`, so `new URL()` received the literal
 * `${POSTGRES_PORT}` as the port and failed with "Invalid URL" unless the
 * caller exported a literal DATABASE_URL. The placeholders are now expanded
 * the same way here, and one that has no value is a clear error instead.
 */
function loadTestEnv(): void {
  dotenvExpand.expand(dotenv.config());
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.TEST_DATABASE_URL ?? env.DATABASE_URL;

  if (!raw) {
    throw new Error(
      "Please provide DATABASE_URL (or TEST_DATABASE_URL) for the integration tests",
    );
  }

  // A variable exported by the shell is not expanded by dotenv-expand (it only
  // touches what it parsed), so the placeholders are resolved here as well.
  const missing: string[] = [];
  const expanded = raw.replace(
    PLACEHOLDER,
    (_match, name: string, fallback?: string) => {
      const value = env[name] ?? fallback;
      if (value === undefined) missing.push(name);
      return value ?? "";
    },
  );

  if (missing.length > 0) {
    throw new Error(
      `DATABASE_URL references ${missing.map((name) => `\${${name}}`).join(", ")} with no value`,
    );
  }

  try {
    new URL(expanded);
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid connection URL after expansion",
    );
  }

  return expanded;
}

/** The same server and credentials, pointed at another database. */
function connectionFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);

  // The path is `/<database>`; the schema stays public, which is where a fresh
  // database puts the extension anyway.
  url.pathname = `/${database}`;
  url.searchParams.set("schema", "public");

  return url.toString();
}

/**
 * The server's maintenance database: you cannot create or drop a database
 * while connected to it.
 */
function adminConnection(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  url.searchParams.delete("schema");

  return url.toString();
}

export { adminConnection, connectionFor, loadTestEnv, testDatabaseUrl };
