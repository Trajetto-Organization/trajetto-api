import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  API_SCOPES,
  RESERVED_API_SCOPES,
} from "@/shared/integration/api-key-rules";
import { createApiKeySchema } from "@/schemas/integration-schema";

/**
 * Scopes a key can carry that no route requires.
 *
 * `webhooks:manage` is published but guards nothing yet. A key issued with it
 * today would gain access, silently, on the day a route starts requiring it —
 * granted by somebody who, when they granted it, was granting nothing. So it
 * cannot be issued until that route exists; keys already holding it are
 * cleaned by a data migration. `deliveries:write` left the list when
 * POST /integration/v1/deliveries shipped (decision 5.10).
 */
const routes = readFileSync(
  resolve(process.cwd(), "src/routes/integration-routes.ts"),
  "utf8",
);

const required = new Set(
  [...routes.matchAll(/verifyApiScope\("([^"]+)"\)/g)].map((match) => match[1]),
);

describe("the scopes a key can be issued with", () => {
  it("are exactly the ones some route requires", () => {
    const grantable = API_SCOPES.filter(
      (scope) => !RESERVED_API_SCOPES.includes(scope),
    );

    expect([...grantable].sort()).toEqual([...required].sort());
  });

  it("refuse a reserved scope at issue", () => {
    for (const scope of RESERVED_API_SCOPES) {
      const parsed = createApiKeySchema.safeParse({
        name: "ERP",
        scopes: ["deliveries:read", scope],
      });

      expect(parsed.success, scope).toBe(false);
    }
  });

  it("still issue the routed ones", () => {
    expect(
      createApiKeySchema.safeParse({
        name: "ERP",
        scopes: ["deliveries:read", "routes:read", "events:read"],
      }).success,
    ).toBe(true);
  });

  it("issue deliveries:write now that a route requires it", () => {
    // Decision 5.10: an ERP pushes documents with a write-only key.
    expect(required.has("deliveries:write")).toBe(true);

    expect(
      createApiKeySchema.safeParse({
        name: "ERP",
        scopes: ["deliveries:write"],
      }).success,
    ).toBe(true);
  });

  it("say the refusal in the right number", () => {
    // One reserved scope left: "Os escopos webhooks:manage estão" was what
    // the plural sentence printed.
    const parsed = createApiKeySchema.safeParse({
      name: "ERP",
      scopes: ["webhooks:manage"],
    });

    expect(parsed.success).toBe(false);

    const message = parsed.success ? "" : parsed.error.issues[0].message;

    expect(message).toBe(
      "O escopo webhooks:manage está reservado: nenhum endpoint da v1 o exige ainda.",
    );
  });

  it("are cleaned from keys issued before, by a migration", () => {
    const migrations = resolve(process.cwd(), "prisma/migrations");

    const sql = readFileSync(
      resolve(
        migrations,
        "20260924120900_api_key_drop_reserved_scopes/migration.sql",
      ),
      "utf8",
    );

    for (const scope of RESERVED_API_SCOPES) {
      expect(sql).toContain(`'${scope}'`);
    }

    expect(sql).toMatch(/array_remove/);
  });
});
