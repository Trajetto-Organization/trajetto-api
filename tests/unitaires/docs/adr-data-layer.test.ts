import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ADR 0013, the data layer (plano-escala F4-61, wave 17).
 *
 * The plan had three different ADR 0013 drafts; decision D58 kept the
 * number for the data layer, and this record joins the PITR, the standby,
 * PgBouncer, the database roles and the explicit reads in one place. It
 * is read the day someone wants to route a query to the standby, send the
 * batch pool through PgBouncer or automate the failover, so what it says
 * must stay true: its sources have to exist, and the rules the code
 * enforces have to be the ones it states.
 */
const ROOT = process.cwd();
const ADR = "docs/adr/0013-camada-de-dados.md";

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");
}

describe("ADR 0013 (the data layer)", () => {
  const text = read(ADR);
  const lines = text.split("\n");

  it("has its Status and the sections every ADR has, in order", () => {
    expect(lines[0]).toMatch(/^# ADR 0013 — /);
    expect(text).toMatch(/^- \*\*Status:\*\* aceito em \d{2}\/\d{2}\/\d{4}/m);

    const sections = [
      "## Contexto",
      "## Decisão",
      "## Consequências",
      "## Fontes",
    ].map((heading) => lines.indexOf(heading));

    expect(sections.every((position) => position > 0)).toBe(true);
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);
  });

  it("decides each piece of the data layer under its own heading", () => {
    for (const heading of [
      "### 1. PITR com pgBackRest, na imagem do banco",
      "### 2. Roles: o runtime sem superusuário",
      "### 3. PgBouncer em modo transaction, o endpoint estável",
      "### 4. Standby físico, pronto na imagem",
      "### 5. Leituras explícitas, nunca por padrão",
      "### 6. Failover manual, com a época do cluster",
    ]) {
      expect(lines, heading).toContain(heading);
    }
  });

  it("is in the ADR index with its status", () => {
    const row = read("docs/adr/README.md")
      .split("\n")
      .find((line) => line.includes("(./0013-camada-de-dados.md)"));

    expect(row).toBeDefined();
    expect(row).toMatch(/\| aceito em 19\/11\/2026 +\|$/);
  });

  it("cites only sources that exist in the repository", () => {
    const fontes = text.slice(text.indexOf("## Fontes"));
    const paths = [
      ...new Set(
        [
          ...text.matchAll(
            /`((?:src|infra|prisma|tests|docs|\.github)\/[\w./-]+)`/g,
          ),
        ].map((match) => match[1]),
      ),
    ];

    expect(paths.length).toBeGreaterThan(15);
    expect(paths.filter((path) => !existsSync(resolve(ROOT, path)))).toEqual(
      [],
    );
    // The guards and the infra phase are what keep the rules true.
    for (const guard of [
      "tests/unitaires/database/read-routing-guard.test.ts",
      "tests/unitaires/database/replica-guard.test.ts",
      "tests/E2E/infra/",
    ]) {
      expect(fontes, guard).toContain(guard);
    }
  });

  it("states the rules the code enforces", () => {
    for (const rule of [
      // F4-31: a pooled URL carries no session setting but the TimeZone.
      "só o `TimeZone`",
      // The batch pool and the migration never go through PgBouncer.
      "**O batch e a migração nunca pelo PgBouncer**",
      // F4-32: PgBouncer's refusals are a 503 with Retry-After.
      "503 com `Retry-After`",
      // F4-41: the replica guard's ceiling.
      "15 s",
      // F4-42 and D53: lists only on the standby.
      "só LISTAS",
      // D61: production archiving after the runtime left the superuser.
      "`DATABASE_REQUIRE_RUNTIME_ROLE=true`",
      // D6: no automatic failover until a contract asks for it.
      "RTO < 5 min",
    ]) {
      expect(text, rule).toContain(rule);
    }
  });
});
