import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SESSION_CHECK_COVERAGE,
  SESSION_REVOCATION_KINDS,
  SESSION_REVOCATION_TRIGGERS,
  coveredColumns,
} from "@/shared/auth/session-revocation";

/**
 * Every column the session check reads has a trigger that logs its change
 * (plano-escala F5-21).
 *
 * The revocation feed (F5-22) and the session cache (F5-23) learn that a
 * session ended or narrowed only from session_revocation_log. A check
 * added on a column no trigger covers would be seen by the next fresh read
 * and by nothing else: a socket would keep it until its sweep, and a
 * cached session until its TTL. So the code of the check is read here, and
 * every `user.<field>` and `driverRecord.<field>` it touches must be in
 * SESSION_CHECK_COVERAGE, naming columns some trigger covers. The E2E
 * session-revocation-triggers holds the database to the triggers.
 */
const CHECK_FILES = [
  "src/modules/user/services/session-eligibility.ts",
  "src/modules/middlewares/ensure-authenticated.ts",
  "src/shared/socket/socket-revalidation.ts",
];

function fieldsRead(): Set<string> {
  const found = new Set<string>();

  for (const file of CHECK_FILES) {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");

    // `user.x` and `driverRecord.x`, not `prisma.user.findMany`.
    for (const [, object, field] of source.matchAll(
      /(?<![.\w])(user|driverRecord)\??\.([A-Za-z_]+)/g,
    )) {
      found.add(`${object}.${field}`);
    }

    if (/\bfamilyActive\b|\bhasActiveFamily\b/.test(source)) {
      found.add("familyActive");
    }
  }

  return found;
}

describe("the session check's coverage", () => {
  it("names every field the check reads", () => {
    const uncovered = [...fieldsRead()].filter(
      (field) => !(field in SESSION_CHECK_COVERAGE),
    );

    expect(
      uncovered,
      "um campo novo lido pela conferência da sessão precisa de gatilho (session-revocation.ts e uma migration)",
    ).toEqual([]);
  });

  it("maps each field to columns a trigger covers", () => {
    const covered = coveredColumns();
    const missing = Object.entries(SESSION_CHECK_COVERAGE).flatMap(
      ([field, columns]) =>
        columns
          .filter((column) => !covered.has(column))
          .map((column) => `${field} → ${column}`),
    );

    expect(missing).toEqual([]);
  });

  it("knows the password and the deletions as revocations too", () => {
    const covered = coveredColumns();

    expect(covered.has("user.password")).toBe(true);

    for (const table of [
      "user",
      "business",
      "branch",
      "driver",
      "refresh_token",
      "profile_access",
      "permission",
      "business_entitlement",
    ]) {
      expect(
        SESSION_REVOCATION_TRIGGERS.some(
          (trigger) => trigger.table === table && trigger.event === "DELETE",
        ),
        table,
      ).toBe(true);
    }
  });

  it("writes only the kinds the feed knows", () => {
    for (const trigger of SESSION_REVOCATION_TRIGGERS) {
      expect(SESSION_REVOCATION_KINDS, trigger.name).toContain(trigger.kind);
    }

    expect(
      new Set(SESSION_REVOCATION_TRIGGERS.map((trigger) => trigger.name)).size,
    ).toBe(SESSION_REVOCATION_TRIGGERS.length);
  });
});
