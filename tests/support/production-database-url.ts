import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The production connection strings, as `.env.example` models them.
 *
 * Production and staging run the API as a Dokploy Application whose
 * environment is typed in the panel, so the only versioned copy of the
 * production DATABASE_URL and MIGRATION_DATABASE_URL (the query parameters
 * that bound a dead peer, a runaway statement, a lock wait) is the commented
 * template in `.env.example`. The tests that pin those parameters read it
 * from there.
 */
export type ProductionDatabaseVariable =
  | "DATABASE_URL"
  | "MIGRATION_DATABASE_URL";

/** The commented `# NAME=postgresql://...` template, as a URL. */
export function productionDatabaseUrl(name: ProductionDatabaseVariable): URL {
  const example = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
  const templates = [
    ...example.matchAll(
      new RegExp(`^#\\s*${name}=(postgresql://\\S+)\\s*$`, "gm"),
    ),
  ].map((match) => match[1]);

  if (templates.length !== 1) {
    throw new Error(
      `.env.example deve ter exatamente um modelo comentado "# ${name}=postgresql://..." de produção (achou ${templates.length})`,
    );
  }

  return new URL(templates[0]);
}

/** The template pointed at another database, its query string untouched. */
export function productionDatabaseUrlFor(
  name: ProductionDatabaseVariable,
  target: {
    username: string;
    password: string;
    host: string;
    port: string;
    database: string;
  },
): URL {
  const url = productionDatabaseUrl(name);

  url.username = target.username;
  url.password = target.password;
  url.hostname = target.host;
  url.port = target.port;
  url.pathname = `/${target.database}`;

  return url;
}
