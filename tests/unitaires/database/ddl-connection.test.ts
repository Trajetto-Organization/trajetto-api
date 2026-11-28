import { describe, expect, it } from "vitest";

import {
  ddlDatabaseUrl,
  openDdlConnection,
} from "@/shared/database/ddl-connection";

/**
 * Where the partition job's DDL connection opens (plano-escala F3-20).
 *
 * It ran on DATABASE_URL, the runtime's URL: after the cut of the database
 * roles that is trajetto_http, which is not a member of the partitions'
 * owner, and every DETACH and DROP would fail with 42501 while the batch
 * pool's transactions, on BATCH_DATABASE_URL, went on. The DDL connection
 * now takes the batch URL too, and DATABASE_URL only without it (before the
 * cut, in development and the tests), as the batch pool does. The whole job
 * as a login that is only trajetto_batch is in tests/E2E/database-roles.
 */
const BATCH = "postgresql://trajetto_batch:x@db.example.com:5432/trajetto";
const RUNTIME = "postgresql://trajetto_http:x@db.example.com:5432/trajetto";

describe("ddlDatabaseUrl", () => {
  it("takes BATCH_DATABASE_URL over DATABASE_URL", () => {
    expect(
      ddlDatabaseUrl({ BATCH_DATABASE_URL: BATCH, DATABASE_URL: RUNTIME }),
    ).toBe(BATCH);
  });

  it("falls back to DATABASE_URL without a batch URL, empty counting as none", () => {
    expect(ddlDatabaseUrl({ DATABASE_URL: RUNTIME })).toBe(RUNTIME);
    expect(
      ddlDatabaseUrl({ BATCH_DATABASE_URL: "  ", DATABASE_URL: RUNTIME }),
    ).toBe(RUNTIME);
  });

  it("has nothing to open without either", () => {
    expect(ddlDatabaseUrl({})).toBeUndefined();
  });

  // The DDL connection switches its SESSION's role (SET ROLE
  // trajetto_partitions) and runs DETACH … CONCURRENTLY. Through PgBouncer
  // in transaction mode the SET would stay on a pooled server connection
  // that the next client's transaction gets: a request running as the
  // owner of the trail. The env refuses a BATCH_DATABASE_URL through it;
  // the fallback to DATABASE_URL (through PgBouncer from wave 17 on) must
  // be refused too, before a byte goes out.
  it.each([
    ["the PgBouncer port", "postgresql://u:x@127.0.0.1:6432/trajetto"],
    [
      "Prisma's pgbouncer=true",
      "postgresql://u:x@127.0.0.1:5432/trajetto?pgbouncer=TRUE",
    ],
  ])("refuses a URL through %s, naming the batch URL", async (_case, url) => {
    await expect(openDdlConnection(url)).rejects.toThrow(
      /PgBouncer[\s\S]*BATCH_DATABASE_URL/,
    );
  });

  it("refuses to open without a URL, naming both variables", async () => {
    await expect(openDdlConnection("")).rejects.toThrow(
      "a conexão de DDL das partições precisa de BATCH_DATABASE_URL ou DATABASE_URL",
    );
  });
});
