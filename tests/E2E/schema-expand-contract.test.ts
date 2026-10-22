import { afterAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_OCCURRENCE_TYPES,
  ensureDefaultOccurrenceTypes,
} from "@/shared/delivery/default-occurrence-types";
import { COLUMN_DEFAULTS_BY_TABLE } from "@/shared/in-memory/column-defaults";

import { DriverPauseRepository } from "@/modules/driver-pause/repositories/driver-pause-repository";

import { pauseTypeId } from "./support/pause-type-seed";

/**
 * The database objects the next release's code is written against.
 *
 * The migrations 20260924090000..20260924091600 were written in one step,
 * before the code that uses them, so the code could be written in parallel
 * without anybody touching the schema. This file pins what that code relies
 * on — especially what schema.prisma cannot say: partial and BRIN indexes, a
 * standalone sequence, a unique that makes a resend a no-op, and the legacy
 * columns the PREVIOUS image still selects (expand/contract).
 *
 * Like schema-indexes.test.ts, it asserts what the migration FILES produce: the
 * environment builds a fresh database per file with `migrate deploy`.
 */
const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

interface ColumnRow {
  column_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  data_type: string;
}

async function columnsOf(table: string): Promise<Map<string, ColumnRow>> {
  const rows = await prisma.$queryRawUnsafe<ColumnRow[]>(
    `SELECT column_name, is_nullable, column_default, data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    table,
  );

  return new Map(rows.map((row) => [row.column_name, row]));
}

/**
 * The statements of a migration FILE, split on the semicolons that end them:
 * not the ones inside a literal, a quoted identifier or a DO $$ ... $$ body,
 * and never inside a comment. The data migrations below are exercised by
 * running their real SQL, one statement at a time (Prisma's raw calls take
 * one statement each).
 */
function migrationStatements(name: string): string[] {
  return sqlStatements(
    resolve(process.cwd(), "prisma/migrations", name, "migration.sql"),
  );
}

/** The same split for any SQL file (the owner-run backfills too). */
function sqlStatements(path: string): string[] {
  const sql = readFileSync(path, "utf8");

  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];

    if (char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      continue;
    }

    if (char === "'" || char === '"') {
      let j = i + 1;

      while (j < sql.length) {
        if (sql[j] === char && sql[j + 1] === char) j += 2;
        else if (sql[j] === char) break;
        else j += 1;
      }

      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    const tag =
      char === "$" ? /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0] : undefined;

    if (tag) {
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());

  return statements;
}

/**
 * Runs `work` in a transaction that is always rolled back and returns what it
 * produced. DDL is transactional in Postgres, so a test can put a column back
 * the way it was before a migration, replay the migration and look, with
 * nothing surviving it.
 */
async function rolledBack<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const marker = Symbol("rollback");

  return prisma
    .$transaction(
      async (tx) => {
        const result = await work(tx);
        throw Object.assign(new Error("rollback"), { [marker]: true, result });
      },
      { timeout: 30_000 },
    )
    .catch((error: Error & { result?: T; [key: symbol]: unknown }) => {
      if (!error[marker]) throw error;
      return error.result as T;
    });
}

let seedSequence = 0;

/** A company to hang rows on, with the fields its table requires. */
async function seedBusiness(
  client: Pick<Prisma.TransactionClient, "$executeRawUnsafe"> = prisma,
): Promise<string> {
  seedSequence += 1;
  const id = `018f3000-0000-7000-8000-${String(seedSequence).padStart(12, "0")}`;

  await client.$executeRawUnsafe(
    `INSERT INTO "business" ("id", "corporate_reason", "cep", "city", "uf", "street",
       "address_number", "cnpj", "cnae", "responsible_name", "telephone", "email", "updated_at")
     VALUES ($1, $2, '01001000', 'São Paulo', 'SP', 'Rua', '1', $3, '4930202',
       'Responsável', '11999999999', $4, now())`,
    id,
    `Transportadora ${id}`,
    `cnpj-${id}`,
    `${id}@exemplo.com.br`,
  );

  return id;
}

async function indexDefinition(name: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
    name,
  );

  return rows[0]?.indexdef ?? null;
}

describe("what the previous image still reads", () => {
  /**
   * A start-first deploy runs the migrations while the old replicas serve,
   * and an automatic rollback puts the old image back on this schema. Its
   * Prisma client names every scalar column it knows in its SELECTs, so a
   * column it knows must not disappear in the same release that stops using
   * it — that was a P2022 on every authenticated request.
   */
  it("keeps the columns the last release selects", async () => {
    const user = await columnsOf("user");
    const business = await columnsOf("business");

    expect(user.get("whatsapp_instance_connected")?.column_default).toBe(
      "false",
    );
    expect(business.get("ai_analysis_used")?.column_default).toBe("0");
    expect(business.has("ai_analysis_reset_at")).toBe(true);
  });

  it("adds NOT NULL columns only with a default the old INSERTs can rely on", async () => {
    const user = await columnsOf("user");

    expect(user.get("failed_login_attempts")).toMatchObject({
      is_nullable: "NO",
      column_default: "0",
    });
    expect(user.get("failed_login_at")?.is_nullable).toBe("YES");
    expect(user.get("login_locked_until")?.is_nullable).toBe("YES");
  });
});

describe("new columns", () => {
  it.each([
    ["push_device_token", "session_family_id"],
    ["domain_outbox_event", "correlationId"],
    ["notification_delivery", "providerStatus"],
    ["notification_delivery", "providerStatusAt"],
    ["delivery_event", "occurred_at"],
    ["delivery_occurrence", "occurred_at"],
    ["webhook_endpoint", "previous_secret"],
    ["webhook_endpoint", "previous_secret_expires_at"],
    ["fine", "client_submission_id"],
    ["account_payable", "client_submission_id"],
    ["service_order", "client_submission_id"],
    ["delivery", "client_submission_id"],
  ])("%s.%s exists and is nullable", async (table, column) => {
    const columns = await columnsOf(table);

    expect(columns.get(column)?.is_nullable).toBe("YES");
  });

  it.each([
    "fine_businessId_client_submission_id_key",
    "account_payable_businessId_client_submission_id_key",
    "service_order_businessId_client_submission_id_key",
    "delivery_businessId_client_submission_id_key",
  ])(
    "the client's idempotency key is unique per company (%s)",
    async (name) => {
      expect(await indexDefinition(name)).toMatch(
        /UNIQUE INDEX .*\("businessId", client_submission_id\)/,
      );
    },
  );
});

describe("new tables", () => {
  it.each([
    "notification_provider_receipt",
    "notification_dead_letter",
    "worker_heartbeat",
  ])("%s exists", async (table) => {
    expect((await columnsOf(table)).size).toBeGreaterThan(0);
  });

  it("dedupes a provider's retried callback", async () => {
    expect(
      await indexDefinition(
        "notification_provider_receipt_provider_providerMessageId_st_key",
      ),
    ).toMatch(/UNIQUE INDEX .*\(provider, "providerMessageId", status\)/);
  });
});

describe("the webhook event sequence", () => {
  it("is a bigint sequence that only moves forward", async () => {
    const [first] = await prisma.$queryRawUnsafe<Array<{ seq: bigint }>>(
      `SELECT nextval('webhook_event_seq') AS seq`,
    );
    const [second] = await prisma.$queryRawUnsafe<Array<{ seq: bigint }>>(
      `SELECT nextval('webhook_event_seq') AS seq`,
    );

    expect(second.seq > first.seq).toBe(true);

    const [type] = await prisma.$queryRawUnsafe<Array<{ data_type: string }>>(
      // regtype, which Prisma cannot deserialize: read as text.
      `SELECT data_type::text AS data_type FROM pg_sequences WHERE sequencename = 'webhook_event_seq'`,
    );

    expect(type?.data_type).toBe("bigint");
  });
});

describe("indexes schema.prisma cannot declare", () => {
  it.each([
    [
      "delivery_delivered_today_idx",
      /\("businessId", delivered_at\) INCLUDE \("driverId"\) WHERE \(status = 'DELIVERED'/,
    ],
    [
      "delivery_failed_recent_idx",
      /\("businessId", updated_at\) INCLUDE \("driverId"\) WHERE \(status = 'FAILED'/,
    ],
    [
      "notification_delivery_claim_internal_idx",
      /\("availableAt"\) WHERE .*'PENDING'.*'PROCESSING'.*'IN_APP'.*'ACTIVITY'.*'PUSH'/,
    ],
    [
      "notification_delivery_claim_external_idx",
      /\("availableAt"\) WHERE .*'PENDING'.*'PROCESSING'.*'EMAIL'.*'WHATSAPP'/,
    ],
    [
      "notification_delivery_failed_idx",
      /\(updated_at, channel\) WHERE \(status = 'FAILED'/,
    ],
    [
      "notification_delivery_providerMessageId_idx",
      /\("providerMessageId"\) WHERE \("providerMessageId" IS NOT NULL\)/,
    ],
    [
      "webhook_delivery_purge_idx",
      /\(created_at\) WHERE \(status = ANY \(ARRAY\['DELIVERED'.*'FAILED'/,
    ],
    ["webhook_delivery_failed_idx", /\(updated_at\) WHERE \(status = 'FAILED'/],
    [
      "ai_analysis_request_fair_claim_idx",
      /\("businessId", created_at\) WHERE \(status = ANY \(ARRAY\['PENDING'.*'PROCESSING'/,
    ],
    [
      "delivery_event_reasonId_partial_idx",
      /\("reasonId"\) WHERE \("reasonId" IS NOT NULL\)/,
    ],
  ])("%s", async (name, shape) => {
    expect(await indexDefinition(name)).toMatch(shape);
  });

  it("has no BRIN on notification_delivery.created_at", async () => {
    // Created by 20260924091100 and dropped again: on a table with two
    // non-HOT updates per row and a daily purge, new rows land in old pages,
    // a BRIN range only widens, and the planner still picked it over a btree
    // — a one-day window read the whole table (see metrics-queries.ts). The
    // metrics read a range of the uuid v7 primary key instead.
    expect(
      await indexDefinition("notification_delivery_created_at_brin_idx"),
    ).toBeNull();
  });
});

describe("one point per driver per instant", () => {
  it("absorbs a resent batch instead of storing it twice", async () => {
    // Today's partition exists: the migration that created the table makes
    // it, and the cron keeps a week ahead.
    const insert = `
      INSERT INTO "driver_position"
        ("id", "driverId", "businessId", "latitude", "longitude", "recorded_at")
      VALUES ($1, 'driver-resend', 'business-resend', -23.5, -46.6, date_trunc('minute', now()))
      ON CONFLICT DO NOTHING`;

    await prisma.$executeRawUnsafe(insert, "first-attempt");
    const second = await prisma.$executeRawUnsafe(insert, "resent-attempt");

    expect(second).toBe(0);
    expect(
      await prisma.driverPosition.count({
        where: { driverId: "driver-resend" },
      }),
    ).toBe(1);
  });
});

describe("uniques that were per-tenant facts", () => {
  it("scopes a branch's ERP code to its company", async () => {
    expect(await indexDefinition("branch_businessId_erp_code_key")).toMatch(
      /UNIQUE INDEX .*\("businessId", erp_code\)/,
    );
    expect(await indexDefinition("branch_erp_code_key")).toBeNull();
  });

  it("no longer treats an RG as unique", async () => {
    expect(await indexDefinition("driver_rg_key")).toBeNull();
  });
});

describe("every foreign key can be found from its child", () => {
  /**
   * Each foreign key is what Postgres searches when the referenced row is
   * deleted (CASCADE, SET NULL or the RESTRICT check), so each needs an index
   * leading with its columns — or a partial one on "<column> IS NOT NULL",
   * which serves the same lookup for a sparse column.
   */
  it("has an index leading with the columns of each foreign key", async () => {
    const uncovered = await prisma.$queryRawUnsafe<
      Array<{ tbl: string; cols: string }>
    >(`
      WITH fk AS (
        SELECT c.conrelid,
               c.conrelid::regclass::text AS tbl,
               c.conkey,
               (SELECT array_agg(a.attname ORDER BY k.ord)
                  FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a
                    ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE c.contype = 'f' AND n.nspname = current_schema()
      )
      SELECT tbl, array_to_string(cols, ',') AS cols
        FROM fk
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_index i
          WHERE i.indrelid = fk.conrelid
            AND (i.indkey::int2[])[0:array_length(fk.conkey, 1) - 1] = fk.conkey::int2[]
            AND (i.indpred IS NULL
                 OR pg_get_expr(i.indpred, i.indrelid)
                    = '(' || quote_ident(fk.cols[1]) || ' IS NOT NULL)')
       )
       ORDER BY 1, 2
    `);

    // Left out on purpose (see the Notification model): only the deletion of
    // a whole tenant reads it, and the bell's writes do not pay for it.
    const allowed = new Set(["notification:businessId"]);

    expect(
      uncovered
        .map((row) => `${row.tbl}:${row.cols}`)
        .filter((key) => !allowed.has(key)),
    ).toEqual([]);
  });
});

// ── Final phase (docs/decisoes-fase-final-2026-09.md), 20260928120000..0700 ──

const FINAL_PHASE_NULLABLE_COLUMNS: Array<[string, string]> = [
  // Fleet (8.4, 8.5)
  ["account_payable", "supplierId"],
  ["account_payable", "vehicleId"],
  ["account_payable", "payee_name"],
  ["account_payable", "description"],
  ["account_payable", "document_number"],
  ["account_payable", "createdById"],
  ["driver", "cnh_category"],
  ["driver", "cnh_expires_at"],
  ["vehicle_type", "required_cnh_category"],
  // Routes (6.4, 6.5)
  ["route", "destination"],
  ["route_stop", "on_the_way_at"],
  // Occurrence form and authorization (6.2, 6.3)
  ["occurrence_type", "form_fields"],
  ["delivery_occurrence", "form_answers"],
  ["delivery_occurrence", "form_version"],
  ["delivery_occurrence", "authorizedById"],
  ["delivery_occurrence", "authorized_at"],
  ["delivery_occurrence", "authorization_note"],
  ["delivery_occurrence", "escalated_at"],
  ["delivery_event", "occurrenceId"],
  // Public API writes (5.10), chat linked to a route (6.7)
  ["delivery", "apiKeyId"],
  ["chat_message", "routeId"],
];

// ── The meeting of 01/10/2026 (decisions 14.2–14.8), 20261005120000..0600 ──
// docs/desenho/esquema-reuniao.md

const MEETING_NULLABLE_COLUMNS: Array<[string, string]> = [
  // Occurrence categories and pauses as types (14.3, 14.4)
  ["occurrence_type", "pause_kind"],
  ["occurrence_type", "system_key"],
  ["occurrence_type", "deactivated_at"],
  ["delivery_occurrence", "receipt_photo"],
  ["delivery_occurrence", "signature"],
  ["delivery_occurrence", "received_by"],
  ["route", "released_at"],
  // The route as the unit of assignment (14.7)
  ["route", "client_submission_id"],
  ["delivery", "latitude"],
  ["delivery", "longitude"],
  ["delivery", "geo_source"],
  ["delivery", "geo_updated_at"],
  // The validated proof model and ICP-Brasil (14.8)
  ["shipper", "corporate_reason"],
  ["delivery_event", "device_id"],
  ["delivery_event", "photo_taken_at"],
  ["delivery_event", "gps_address"],
  ["delivery_event", "gps_address_source"],
  ["delivery_event", "gps_geocoded_at"],
  ["delivery_proof_document", "unsigned_reason"],
  ["delivery_proof_document", "signature_profile"],
  ["delivery_proof_document", "signer_name"],
  ["delivery_proof_document", "signer_cnpj"],
  ["delivery_proof_document", "cert_serial"],
  ["delivery_proof_document", "cert_issuer"],
  ["delivery_proof_document", "cert_not_after"],
  ["delivery_proof_document", "signed_at"],
  // The phone's pre-check (14.2)
  ["delivery_proof_audit", "device_precheck"],
  ["fuel", "odometer_device_precheck"],
  ["vehicle_checklist", "mileage_device_precheck"],
  ["delivery_proof_audit", "device_agreement"],
  ["fuel", "odometer_device_agreement"],
  ["vehicle_checklist", "mileage_device_agreement"],
  // Tickets (14.5)
  ["chat_message", "ticketId"],
];

describe("final phase: new columns", () => {
  it.each(FINAL_PHASE_NULLABLE_COLUMNS)(
    "%s.%s exists and is nullable",
    async (table, column) => {
      const columns = await columnsOf(table);

      expect(columns.get(column)?.is_nullable).toBe("YES");
    },
  );

  it.each([
    ["business", "timezone", "'America/Sao_Paulo'::text"],
    ["occurrence_type", "form_version", "1"],
    ["occurrence_type", "requires_authorization", "false"],
    ["occurrence_type", "is_system", "false"],
    [
      "delivery_occurrence",
      "authorization_status",
      `'NOT_REQUIRED'::"OccurrenceAuthorizationStatus"`,
    ],
  ])(
    "%s.%s is NOT NULL with a default the previous image's INSERTs rely on",
    async (table, column, defaultValue) => {
      expect((await columnsOf(table)).get(column)).toMatchObject({
        is_nullable: "NO",
        column_default: defaultValue,
      });
    },
  );

  it("gives the in-memory repositories the same defaults as the columns", async () => {
    // The fakes apply these constants (decision 13.2); a default changed in
    // a migration and not there, or the other way round, fails here.
    const literalOf = (columnDefault: string | null | undefined): unknown => {
      if (columnDefault == null) return undefined;

      const quoted = /^'(.*)'::/.exec(columnDefault);
      if (quoted) return quoted[1];
      if (columnDefault === "true" || columnDefault === "false") {
        return columnDefault === "true";
      }
      if (/^-?\d+$/.test(columnDefault)) return Number(columnDefault);

      throw new Error(`default sem leitura: ${columnDefault}`);
    };

    const pinned = Object.entries(COLUMN_DEFAULTS_BY_TABLE) as Array<
      [string, Record<string, unknown>]
    >;

    for (const [table, defaults] of pinned) {
      const columns = await columnsOf(table);

      for (const [column, value] of Object.entries(defaults)) {
        const real = columns.get(column);

        // null in a constant = what Postgres stores for an omitted nullable
        // column with no default. A default would make the fake wrong.
        if (value === null) {
          expect(real, `${table}.${column}`).toMatchObject({
            is_nullable: "YES",
            column_default: null,
          });
          continue;
        }

        expect(literalOf(real?.column_default), `${table}.${column}`).toBe(
          value,
        );
      }
    }

    // Every nullable column this phase added reads back as null in the fakes
    // too: a new one missing from the constants fails here.
    const missing = [
      ...FINAL_PHASE_NULLABLE_COLUMNS,
      ...MEETING_NULLABLE_COLUMNS,
    ].filter(
      ([table, column]) =>
        (COLUMN_DEFAULTS_BY_TABLE as Record<string, Record<string, unknown>>)[
          table
        ]?.[column] !== null,
    );

    expect(missing).toEqual([]);
  });

  it("stores the planned days and the CNH expiry as civil dates", async () => {
    // Decision 1.3: what the operator picks is a day, not an instant.
    expect((await columnsOf("delivery")).get("scheduled_date")?.data_type).toBe(
      "date",
    );
    expect((await columnsOf("route")).get("scheduled_date")?.data_type).toBe(
      "date",
    );
    expect((await columnsOf("driver")).get("cnh_expires_at")?.data_type).toBe(
      "date",
    );
  });

  it("takes a fractional km/l", async () => {
    // Decision 8.6: a truck does 2.5-4 km/l.
    expect((await columnsOf("vehicle")).get("km_per_liter")?.data_type).toBe(
      "double precision",
    );
  });

  it("has the enums the decisions name, with every value", async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ type: string; value: string }>
    >(
      `SELECT t.typname AS type, e.enumlabel AS value
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname IN ('CnhCategory', 'OccurrenceAuthorizationStatus',
                            'DriverPauseKind', 'DeliveryEventType', 'DeliveryMessageTopic')
        ORDER BY t.typname, e.enumsortorder`,
    );
    const valuesOf = (type: string) =>
      rows.filter((row) => row.type === type).map((row) => row.value);

    expect(valuesOf("CnhCategory")).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "AB",
      "AC",
      "AD",
      "AE",
    ]);
    expect(valuesOf("OccurrenceAuthorizationStatus")).toEqual([
      "NOT_REQUIRED",
      "PENDING",
      "APPROVED",
      "DENIED",
      "SUPERSEDED",
    ]);
    expect(valuesOf("DriverPauseKind")).toEqual(["MEAL", "REST", "OTHER"]);
    expect(valuesOf("DeliveryEventType")).toEqual(
      expect.arrayContaining(["ON_THE_WAY", "OCCURRENCE"]),
    );
    expect(valuesOf("DeliveryMessageTopic")).toEqual(
      expect.arrayContaining(["ON_THE_WAY"]),
    );
  });
});

describe("final phase: a civil date through Prisma", () => {
  it("keeps the UTC day of what it is given and reads it back as midnight UTC", async () => {
    // The contract the API and the screens build on: send "2026-09-17"
    // (parsed as 00:00Z) or the browser's local midnight (03:00Z in
    // Brasilia) and the route is on the 17th; the value read back is
    // 2026-09-17T00:00:00Z, formatted with timeZone "UTC".
    const businessId = await seedBusiness();
    const driver = await prisma.driver.create({
      data: {
        name: "Motorista data",
        birth_date: new Date("1990-01-01"),
        cnh: "cnh-civil-date",
        cpf: "cpf-civil-date",
        rg: "rg",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId,
      },
    });

    const route = await prisma.route.create({
      data: {
        code: 1,
        businessId,
        driverId: driver.id,
        scheduled_date: new Date("2026-09-17T03:00:00.000Z"),
      },
    });

    expect(route.scheduled_date.toISOString()).toBe("2026-09-17T00:00:00.000Z");

    // A filter spelled with instants still finds it: the day boundary of the
    // business day lands on the right date.
    expect(
      await prisma.route.count({
        where: {
          businessId,
          scheduled_date: {
            gte: new Date("2026-09-17T03:00:00.000Z"),
            lt: new Date("2026-09-18T03:00:00.000Z"),
          },
        },
      }),
    ).toBe(1);
  });
});

describe("final phase: the planned-day conversion (20260928120300)", () => {
  it("turns every stored instant into the day it meant, whatever the session zone", async () => {
    const [toDateDelivery, toDateRoute] = migrationStatements(
      "20260928120300_date_only_scheduled_dates",
    );

    const seen = await rolledBack(async (tx) => {
      // The columns as the rows were written: timestamps.
      await tx.$executeRawUnsafe(
        `ALTER TABLE "delivery" ALTER COLUMN "scheduled_date" TYPE TIMESTAMP(3)`,
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "route" ALTER COLUMN "scheduled_date" TYPE TIMESTAMP(3)`,
      );

      const businessId = await seedBusiness(tx);

      await tx.$executeRawUnsafe(
        `INSERT INTO "shipper" ("id", "name", "businessId", "updated_at")
         VALUES ('shipper-date', 'Embarcador', $1, now())`,
        businessId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "driver" ("id", "name", "birth_date", "cnh", "cpf", "rg", "cep", "city",
           "uf", "street", "address_number", "status", "contract_type", "businessId", "updated_at")
         VALUES ('driver-date', 'Motorista', '1990-01-01', 'cnh-date', 'cpf-date', 'rg', '0',
           'c', 'SP', 's', '1', 'ACTIVE', 'OWNED', $1, now())`,
        businessId,
      );

      // The web's local midnight (03:00Z) and the spreadsheet's UTC midnight
      // (00:00Z) of the same chosen day.
      for (const [id, stored] of [
        ["web", "2026-09-17 03:00:00"],
        ["sheet", "2026-09-17 00:00:00"],
      ]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "delivery" ("id", "recipient_name", "city", "uf", "street", "businessId",
             "shipperId", "scheduled_date", "updated_at")
           VALUES ($1, 'Cliente', 'c', 'SP', 's', $2, 'shipper-date', $3::timestamp, now())`,
          `delivery-${id}`,
          businessId,
          stored,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "route" ("id", "code", "businessId", "driverId", "scheduled_date", "updated_at")
           VALUES ($1, $2, $3, 'driver-date', $4::timestamp, now())`,
          `route-${id}`,
          id === "web" ? 1 : 2,
          businessId,
          stored,
        );
      }

      // A session in Brasilia time: the conversion must not consult it.
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/Sao_Paulo'`);

      // The tempting spelling does: through timestamptz, 00:00Z becomes the
      // day before. This is why the migration casts the timestamp directly.
      const [tempting] = await tx.$queryRawUnsafe<Array<{ day: string }>>(
        `SELECT ((TIMESTAMP '2026-09-17 00:00:00') AT TIME ZONE 'UTC')::date::text AS day`,
      );

      await tx.$executeRawUnsafe(toDateDelivery);
      await tx.$executeRawUnsafe(toDateRoute);

      const deliveries = await tx.$queryRawUnsafe<
        Array<{ id: string; day: string }>
      >(
        `SELECT "id", "scheduled_date"::text AS day FROM "delivery"
          WHERE "id" LIKE 'delivery-%' ORDER BY "id"`,
      );
      const routes = await tx.$queryRawUnsafe<
        Array<{ id: string; day: string }>
      >(
        `SELECT "id", "scheduled_date"::text AS day FROM "route"
          WHERE "id" LIKE 'route-%' ORDER BY "id"`,
      );

      return { tempting: tempting.day, deliveries, routes };
    });

    expect(seen.tempting).toBe("2026-09-16");
    expect(seen.deliveries).toEqual([
      { id: "delivery-sheet", day: "2026-09-17" },
      { id: "delivery-web", day: "2026-09-17" },
    ]);
    expect(seen.routes).toEqual([
      { id: "route-sheet", day: "2026-09-17" },
      { id: "route-web", day: "2026-09-17" },
    ]);
  });
});

describe("final phase: uniques are per company (decision 8.1)", () => {
  function driverData(businessId: string, suffix: string) {
    return {
      name: `Motorista ${suffix}`,
      birth_date: new Date("1990-01-01"),
      cnh: "12345678900",
      cpf: "52998224725",
      rg: "rg",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE" as const,
      contract_type: "OWNED" as const,
      businessId,
    };
  }

  function branchData(businessId: string, cnpj: string) {
    return {
      corporate_reason: "Filial Centro Ltda",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "contato@filial.com.br",
      businessId,
    };
  }

  async function vehicleData(businessId: string) {
    const fuelType = await prisma.fuelType.create({
      data: { description: "Diesel", businessId },
    });

    return {
      description: "Caminhão",
      license_plate: "ABC1D23",
      brand: "Volvo",
      model: "FH",
      acquisition_date: new Date("2024-01-01"),
      fleet_type: "THIRD_PARTY" as const,
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: "12345678901",
      manufacturing_year: new Date("2023-01-01"),
      model_year: new Date("2024-01-01"),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE" as const,
      businessId,
      fuelTypeId: fuelType.id,
    };
  }

  it("lets two carriers register the same driver and the same aggregated truck", async () => {
    const carrierA = await seedBusiness();
    const carrierB = await seedBusiness();

    await prisma.driver.create({ data: driverData(carrierA, "A") });
    await expect(
      prisma.driver.create({ data: driverData(carrierB, "B") }),
    ).resolves.toMatchObject({ cpf: "52998224725", businessId: carrierB });

    await prisma.vehicle.create({ data: await vehicleData(carrierA) });
    await expect(
      prisma.vehicle.create({ data: await vehicleData(carrierB) }),
    ).resolves.toMatchObject({
      license_plate: "ABC1D23",
      businessId: carrierB,
    });

    await prisma.branch.create({
      data: branchData(carrierA, `branch-a-${carrierA}`),
    });
    await expect(
      prisma.branch.create({
        data: branchData(carrierB, `branch-b-${carrierB}`),
      }),
    ).resolves.toMatchObject({ corporate_reason: "Filial Centro Ltda" });
  });

  it("still refuses the same CPF, CNH, plate, RENAVAM, corporate name or e-mail twice in one company", async () => {
    const carrier = await seedBusiness();

    await prisma.driver.create({ data: driverData(carrier, "1") });
    await prisma.vehicle.create({ data: await vehicleData(carrier) });
    await prisma.branch.create({
      data: branchData(carrier, `branch-1-${carrier}`),
    });

    const refusedOn = async (create: Promise<unknown>) =>
      create.then(
        () => null,
        (error: Prisma.PrismaClientKnownRequestError) =>
          [
            error.code,
            (error.meta?.target as string[] | undefined)?.join(","),
          ].join(" "),
      );

    expect(
      await refusedOn(
        prisma.driver.create({
          data: { ...driverData(carrier, "2"), cnh: "other-cnh" },
        }),
      ),
    ).toBe("P2002 businessId,cpf");
    expect(
      await refusedOn(
        prisma.driver.create({
          data: { ...driverData(carrier, "3"), cpf: "other-cpf" },
        }),
      ),
    ).toBe("P2002 businessId,cnh");
    expect(
      await refusedOn(
        prisma.vehicle.create({
          data: { ...(await vehicleData(carrier)), renavam: "other-renavam" },
        }),
      ),
    ).toBe("P2002 businessId,license_plate");
    expect(
      await refusedOn(
        prisma.vehicle.create({
          data: { ...(await vehicleData(carrier)), license_plate: "XYZ9Z99" },
        }),
      ),
    ).toBe("P2002 businessId,renavam");
    expect(
      await refusedOn(
        prisma.branch.create({
          data: {
            ...branchData(carrier, `branch-2-${carrier}`),
            email: "outro@filial.com.br",
          },
        }),
      ),
    ).toBe("P2002 businessId,corporate_reason");
    expect(
      await refusedOn(
        prisma.branch.create({
          data: {
            ...branchData(carrier, `branch-3-${carrier}`),
            corporate_reason: "Outra Filial Ltda",
          },
        }),
      ),
    ).toBe("P2002 businessId,email");
  });

  it("keeps the branch CNPJ national", async () => {
    expect(await indexDefinition("branch_cnpj_key")).toMatch(
      /UNIQUE INDEX .*\(cnpj\)/,
    );
  });

  it.each([
    "driver_cpf_key",
    "driver_cnh_key",
    "vehicle_license_plate_key",
    "vehicle_renavam_key",
    "branch_corporate_reason_key",
    "branch_email_key",
  ])("drops the platform-wide %s", async (name) => {
    expect(await indexDefinition(name)).toBeNull();
  });
});

describe("final phase: one shipper per CNPJ per company (20260928120000)", () => {
  it("refuses a second shipper with the same CNPJ in a company, and never a null one", async () => {
    const carrier = await seedBusiness();
    const other = await seedBusiness();

    await prisma.shipper.create({
      data: { name: "Alfa", cnpj: "11222333000181", businessId: carrier },
    });
    await prisma.shipper.create({
      data: { name: "Sem CNPJ 1", businessId: carrier },
    });

    await expect(
      prisma.shipper.create({
        data: { name: "Beta", cnpj: "11222333000181", businessId: carrier },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Another company, and shippers without a CNPJ, do not collide.
    await expect(
      prisma.shipper.create({
        data: { name: "Alfa", cnpj: "11222333000181", businessId: other },
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.shipper.create({
        data: { name: "Sem CNPJ 2", businessId: carrier },
      }),
    ).resolves.toBeTruthy();
  });

  it("fails the migration on existing duplicates, naming them, before building the index", async () => {
    const [blankToNull, guard] = migrationStatements(
      "20260928120000_shipper_cnpj_unique",
    );

    const failure = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(`DROP INDEX "shipper_businessId_cnpj_key"`);

      const carrier = await seedBusiness(tx);

      for (const name of ["Alfa Distribuidora", "Alfa Filial"]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "shipper" ("id", "name", "cnpj", "businessId", "updated_at")
           VALUES ($1, $2, '11222333000181', $3, now())`,
          `shipper-${name}`,
          name,
          carrier,
        );
      }

      await tx.$executeRawUnsafe(blankToNull);

      return tx.$executeRawUnsafe(guard).then(
        () => null,
        (error: Error) => error.message,
      );
    });

    expect(failure).toContain("Embarcadores com o mesmo CNPJ na mesma empresa");
    expect(failure).toContain("11222333000181");
    expect(failure).toContain("Alfa Distribuidora");
    expect(failure).toContain("Alfa Filial");
  });

  it("does not count blank or missing CNPJs as duplicates", async () => {
    const [blankToNull, guard, createIndex] = migrationStatements(
      "20260928120000_shipper_cnpj_unique",
    );

    const outcome = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(`DROP INDEX "shipper_businessId_cnpj_key"`);

      const carrier = await seedBusiness(tx);

      for (const [id, cnpj] of [
        ["blank-1", ""],
        ["blank-2", "  "],
        ["null-1", null],
        ["null-2", null],
      ]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "shipper" ("id", "name", "cnpj", "businessId", "updated_at")
           VALUES ($1, $1, $2, $3, now())`,
          `shipper-${id}`,
          cnpj,
          carrier,
        );
      }

      await tx.$executeRawUnsafe(blankToNull);
      await tx.$executeRawUnsafe(guard);
      await tx.$executeRawUnsafe(createIndex);

      return tx.$queryRawUnsafe<Array<{ blank: bigint }>>(
        `SELECT count(*) AS blank FROM "shipper" WHERE "businessId" = $1 AND "cnpj" IS NOT NULL`,
        carrier,
      );
    });

    expect(outcome[0].blank).toBe(0n);
  });
});

describe("final phase: one open pause per driver", () => {
  it("refuses a second open pause and accepts the next one once the first ends", async () => {
    const businessId = await seedBusiness();
    const driver = await prisma.driver.create({
      data: {
        name: "Motorista pausa",
        birth_date: new Date("1990-01-01"),
        cnh: "cnh-pause",
        cpf: "cpf-pause",
        rg: "rg",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        address_number: "1",
        status: "ACTIVE",
        contract_type: "OWNED",
        businessId,
      },
    });

    const mealType = await pauseTypeId(prisma, businessId, "MEAL");

    const start = (
      id: string,
      submission: string,
      endedAt: string | null = null,
    ) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "driver_pause" ("id", "kind", "started_at", "ended_at",
           "start_submission_id", "driverId", "businessId", "occurrenceTypeId", "updated_at")
         VALUES ($1, 'MEAL', now(), $2::timestamp, $3, $4, $5, $6, now())`,
        id,
        endedAt,
        submission,
        driver.id,
        businessId,
        mealType,
      );

    // Prisma's raw error carries Postgres's key detail, not the index name:
    // ("driverId") alone is driver_pause_one_open_idx.
    await start("pause-1", "start-1");
    await expect(start("pause-2", "start-2")).rejects.toThrow(
      /Key \("driverId"\)=/,
    );

    await prisma.$executeRawUnsafe(
      `UPDATE "driver_pause" SET "ended_at" = now(), "end_submission_id" = 'end-1'
        WHERE "id" = 'pause-1'`,
    );

    await expect(start("pause-3", "start-3")).resolves.toBe(1);

    // The same gesture replayed by the outbox (a closed pause, so the
    // open-pause rule is not what refuses it) lands once.
    await expect(
      start("pause-4", "start-1", "2026-09-28 12:00:00"),
    ).rejects.toThrow(/Key \("businessId", start_submission_id\)=/);
  });
});

describe("final phase: data migrations", () => {
  it("marks the proof audit's occurrence type as a system type (20260928120600)", async () => {
    const [markSystem] = migrationStatements(
      "20260928120600_occurrence_type_system_flag",
    );

    const flags = await rolledBack(async (tx) => {
      const carrier = await seedBusiness(tx);

      for (const name of [
        "Comprovante rejeitado",
        "Avaria",
        "comprovante rejeitado (manual)",
      ]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "occurrence_type" ("id", "name", "businessId", "updated_at")
           VALUES ($1, $1, $2, now())`,
          name,
          carrier,
        );
      }

      await tx.$executeRawUnsafe(markSystem);
      // Idempotent.
      await tx.$executeRawUnsafe(markSystem);

      return tx.$queryRawUnsafe<Array<{ name: string; is_system: boolean }>>(
        `SELECT "name", "is_system" FROM "occurrence_type" WHERE "businessId" = $1 ORDER BY "name"`,
        carrier,
      );
    });

    expect(flags).toEqual([
      { name: "Avaria", is_system: false },
      { name: "Comprovante rejeitado", is_system: true },
      { name: "comprovante rejeitado (manual)", is_system: false },
    ]);
  });

  it("turns document.* subscriptions into the three document families (20260928120700)", async () => {
    const [rewrite] = migrationStatements(
      "20260928120700_webhook_document_wildcard",
    );

    const topics = await rolledBack(async (tx) => {
      const carrier = await seedBusiness(tx);

      for (const [id, subscribed] of [
        ["all-documents", ["route.released", "document.*"]],
        ["partly-covered", ["occurrence.*", "document.*"]],
        ["untouched", ["route.*", "delivery.delivered"]],
      ] as const) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "webhook_endpoint" ("id", "name", "url", "secret", "topics", "businessId", "updated_at")
           VALUES ($1, $1, 'https://erp.exemplo.com.br/hook', 'secret', $2::text[], $3, now())`,
          id,
          subscribed,
          carrier,
        );
      }

      await tx.$executeRawUnsafe(rewrite);
      // Idempotent: nothing left to rewrite.
      const second = await tx.$executeRawUnsafe(rewrite);

      const rows = await tx.$queryRawUnsafe<
        Array<{ id: string; topics: string[] }>
      >(
        `SELECT "id", "topics" FROM "webhook_endpoint" WHERE "businessId" = $1 ORDER BY "id"`,
        carrier,
      );

      return { second, rows };
    });

    expect(topics.second).toBe(0);
    expect(topics.rows).toEqual([
      {
        id: "all-documents",
        topics: ["route.released", "delivery.*", "occurrence.*", "proof.*"],
      },
      {
        id: "partly-covered",
        topics: ["occurrence.*", "delivery.*", "proof.*"],
      },
      { id: "untouched", topics: ["route.*", "delivery.delivered"] },
    ]);
  });
});

// ── The meeting of 01/10/2026: schema (20261005120000..0600) ──

type RawClient = Pick<
  Prisma.TransactionClient,
  "$executeRawUnsafe" | "$queryRawUnsafe"
>;

let meetingSequence = 0;

/** A unique suffix for rows this section writes. */
function meetingKey(prefix: string): string {
  meetingSequence += 1;
  return `${prefix}-${meetingSequence}-${Date.now()}`;
}

async function seedDriverRow(
  client: RawClient,
  businessId: string,
  id: string,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "driver" ("id", "name", "birth_date", "cnh", "cpf", "rg", "cep", "city", "uf",
       "street", "address_number", "status", "contract_type", "businessId", "updated_at")
     VALUES ($1, $1, '1990-01-01', $2, $3, 'rg', '01001000', 'São Paulo', 'SP', 'Rua', '1',
       'ACTIVE', 'OWNED', $4, now())`,
    id,
    `cnh-${id}`,
    `cpf-${id}`,
    businessId,
  );
}

async function seedUserRow(
  client: RawClient,
  businessId: string,
  id: string,
  driverId: string | null = null,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "user" ("id", "name", "email", "password", "role", "businessId", "driverId", "updated_at")
     VALUES ($1, $1, $2, 'x', $3::"UserRole", $4, $5, now())`,
    id,
    `${id}@exemplo.com.br`,
    driverId ? "BUSINESS_USER" : "BUSINESS_ADMIN",
    businessId,
    driverId,
  );
}

async function seedDeliveryRow(
  client: RawClient,
  businessId: string,
  id: string,
  recipient: string,
  driverId: string | null,
): Promise<void> {
  const shipper = `shipper-${id}`;

  await client.$executeRawUnsafe(
    `INSERT INTO "shipper" ("id", "name", "businessId", "updated_at") VALUES ($1, $1, $2, now())`,
    shipper,
    businessId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO "delivery" ("id", "recipient_name", "city", "uf", "street", "businessId",
       "shipperId", "driverId", "updated_at")
     VALUES ($1, $2, 'São Paulo', 'SP', 'Rua', $3, $4, $5, now())`,
    id,
    recipient,
    businessId,
    shipper,
    driverId,
  );
}

/** The one statement of a migration file that starts with `prefix`. */
function statementStartingWith(
  migration: string,
  prefix: string,
  occurrence = 0,
): string {
  const found = migrationStatements(migration).filter((statement) =>
    statement.startsWith(prefix),
  );
  const statement = found[occurrence];

  if (!statement)
    throw new Error(`${migration}: nenhum comando começa com ${prefix}`);
  return statement;
}

describe("meeting: new columns", () => {
  it.each(MEETING_NULLABLE_COLUMNS)(
    "%s.%s exists and is nullable",
    async (table, column) => {
      expect((await columnsOf(table)).get(column)?.is_nullable).toBe("YES");
    },
  );

  it.each([
    ["occurrence_type", "category", `'NOT_DELIVERED'::"OccurrenceCategory"`],
    ["occurrence_type", "requires_receipt_photo", "false"],
    ["occurrence_type", "requires_signature", "false"],
    [
      "delivery_occurrence",
      "category",
      `'NOT_DELIVERED'::"OccurrenceCategory"`,
    ],
    ["route", "plan_version", "0"],
    ["delivery_proof_document", "layout_version", "1"],
    [
      "delivery_proof_document",
      "signature_status",
      `'UNSIGNED'::"ProofSignatureStatus"`,
    ],
    ["user", "ops_alert_sound_enabled", "true"],
  ])(
    "%s.%s is NOT NULL with a default the previous image's INSERTs rely on",
    async (table, column, defaultValue) => {
      expect((await columnsOf(table)).get(column)).toMatchObject({
        is_nullable: "NO",
        column_default: defaultValue,
      });
    },
  );

  it("requires the pause type on every pause (backfilled, then NOT NULL)", async () => {
    expect(
      (await columnsOf("driver_pause")).get("occurrenceTypeId"),
    ).toMatchObject({
      is_nullable: "NO",
      column_default: null,
    });
  });

  it("stores the address point in double precision", async () => {
    const delivery = await columnsOf("delivery");

    expect(delivery.get("latitude")?.data_type).toBe("double precision");
    expect(delivery.get("longitude")?.data_type).toBe("double precision");
  });

  it("has the enums the designs name, with every value", async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ type: string; value: string }>
    >(
      `SELECT t.typname AS type, e.enumlabel AS value
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname IN ('OccurrenceCategory', 'DeliveryGeoSource', 'GeocodeSource',
                            'ProofSignatureStatus', 'ProofUnsignedReason', 'ProofSignatureProfile',
                            'SupportTicketKind', 'SupportTicketStatus', 'SupportTicketOpenedVia',
                            'SupportTicketOutcome', 'SupportTicketEventType', 'DeliveryEventType',
                            'DeviceAgreement')
        ORDER BY t.typname, e.enumsortorder`,
    );
    const valuesOf = (type: string) =>
      rows.filter((row) => row.type === type).map((row) => row.value);

    expect(valuesOf("OccurrenceCategory")).toEqual([
      "DELIVERED",
      "NOT_DELIVERED",
      "PAUSE",
    ]);
    expect(valuesOf("DeliveryGeoSource")).toEqual(["MANUAL", "GEOCODER"]);
    expect(valuesOf("GeocodeSource")).toEqual(["PROVIDER", "UNAVAILABLE"]);
    expect(valuesOf("DeviceAgreement")).toEqual([
      "AGREE",
      "DISAGREE",
      "NOT_APPLICABLE",
    ]);
    expect(valuesOf("ProofSignatureStatus")).toEqual(["UNSIGNED", "SIGNED"]);
    expect(valuesOf("ProofUnsignedReason")).toEqual([
      "LEGACY",
      "NO_CERTIFICATE",
      "CERTIFICATE_EXPIRED",
      "CERTIFICATE_INVALID",
      "SIGNING_DISABLED",
    ]);
    expect(valuesOf("ProofSignatureProfile")).toEqual([
      "PADES_AD_RB",
      "CMS_DETACHED",
    ]);
    expect(valuesOf("SupportTicketKind")).toEqual([
      "OCCURRENCE",
      "DELIVERY",
      "ROUTE",
      "DRIVER",
      "LEGACY",
    ]);
    expect(valuesOf("SupportTicketStatus")).toEqual(["OPEN", "CLOSED"]);
    expect(valuesOf("SupportTicketOpenedVia")).toEqual([
      "OCCURRENCE_REPORT",
      "DRIVER_APP",
      "PANEL",
      "LEGACY_ROUTING",
      "MIGRATION",
    ]);
    expect(valuesOf("SupportTicketOutcome")).toEqual([
      "RESOLVED",
      "APPROVED",
      "DENIED",
      "MIGRATED",
    ]);
    expect(valuesOf("SupportTicketEventType")).toEqual([
      "OPENED",
      "ASSIGNED",
      "UNASSIGNED",
      "CLOSED",
      "REOPENED",
      "OCCURRENCE_LINKED",
      "AUTHORIZATION_DECIDED",
      "AUTHORIZATION_SUPERSEDED",
    ]);
    expect(valuesOf("DeliveryEventType")).toEqual(
      expect.arrayContaining(["ROUTE_ADDED", "ROUTE_REMOVED"]),
    );
  });

  it("keys a route's create and a ticket's create per company", async () => {
    expect(
      await indexDefinition("route_businessId_client_submission_id_key"),
    ).toMatch(/UNIQUE INDEX .*\("businessId", client_submission_id\)/);
    expect(
      await indexDefinition(
        "support_ticket_businessId_client_submission_id_key",
      ),
    ).toMatch(/UNIQUE INDEX .*\("businessId", client_submission_id\)/);
    expect(
      await indexDefinition("support_ticket_businessId_number_key"),
    ).toMatch(/UNIQUE INDEX .*\("businessId", number\)/);
  });
});

describe("meeting: occurrence type rules in the database (14.3, 14.4)", () => {
  const insertType = (
    businessId: string,
    columns: Record<string, string | boolean | null>,
  ) => {
    const names = Object.keys(columns);
    const placeholders = names.map((name, index) =>
      name === "category"
        ? `$${index + 3}::"OccurrenceCategory"`
        : name === "pause_kind"
          ? `$${index + 3}::"DriverPauseKind"`
          : `$${index + 3}`,
    );

    return prisma.$executeRawUnsafe(
      `INSERT INTO "occurrence_type" ("id", "businessId", ${names.map((n) => `"${n}"`).join(", ")}, "updated_at")
       VALUES ($1, $2, ${placeholders.join(", ")}, now())`,
      meetingKey("type"),
      businessId,
      ...Object.values(columns),
    );
  };

  it("refuses a pause type without its legal nature, and a nature on any other type", async () => {
    const carrier = await seedBusiness();

    await expect(
      insertType(carrier, {
        name: "Almoço",
        category: "PAUSE",
        pause_kind: null,
      }),
    ).rejects.toThrow(/occurrence_type_pause_kind_chk/);
    await expect(
      insertType(carrier, {
        name: "Recusa",
        category: "NOT_DELIVERED",
        pause_kind: "MEAL",
      }),
    ).rejects.toThrow(/occurrence_type_pause_kind_chk/);

    await expect(
      insertType(carrier, {
        name: "Almoço",
        category: "PAUSE",
        pause_kind: "MEAL",
      }),
    ).resolves.toBe(1);
  });

  it("lets only a não-entrega type block the delivery", async () => {
    const carrier = await seedBusiness();

    await expect(
      insertType(carrier, {
        name: "Entrega bloqueada",
        category: "DELIVERED",
        blocks_delivery: true,
      }),
    ).rejects.toThrow(/occurrence_type_blocks_only_not_delivered_chk/);
    await expect(
      insertType(carrier, {
        name: "Pausa bloqueada",
        category: "PAUSE",
        pause_kind: "REST",
        blocks_delivery: true,
      }),
    ).rejects.toThrow(/occurrence_type_blocks_only_not_delivered_chk/);

    await expect(
      insertType(carrier, {
        name: "Ausente",
        category: "NOT_DELIVERED",
        blocks_delivery: true,
      }),
    ).resolves.toBe(1);
  });

  it.each([
    ["requires_photo"],
    ["requires_receipt_photo"],
    ["requires_signature"],
    ["requires_authorization"],
  ])("refuses a pause type that asks for %s", async (requirement) => {
    const carrier = await seedBusiness();

    await expect(
      insertType(carrier, {
        name: "Café",
        category: "PAUSE",
        pause_kind: "OTHER",
        [requirement]: true,
      }),
    ).rejects.toThrow(/occurrence_type_pause_requirements_chk/);

    // The same requirement on a delivery type is the point of 14.3.
    await expect(
      insertType(carrier, {
        name: `Entrega com ${requirement}`,
        category: "DELIVERED",
        [requirement]: true,
      }),
    ).resolves.toBe(1);
  });

  it("finds a seeded type by its key once per company, and never collides on a null key", async () => {
    const carrier = await seedBusiness();
    const other = await seedBusiness();

    await insertType(carrier, {
      name: "Entrega A",
      category: "DELIVERED",
      system_key: "delivered_default",
    });
    await expect(
      insertType(carrier, {
        name: "Entrega B",
        category: "DELIVERED",
        system_key: "delivered_default",
      }),
    ).rejects.toThrow(/Key \("businessId", system_key\)=/);

    await expect(
      insertType(other, {
        name: "Entrega A",
        category: "DELIVERED",
        system_key: "delivered_default",
      }),
    ).resolves.toBe(1);
    await expect(insertType(carrier, { name: "Sem chave 1" })).resolves.toBe(1);
    await expect(insertType(carrier, { name: "Sem chave 2" })).resolves.toBe(1);
  });

  it("keeps a pause type in use from being deleted (RESTRICT)", async () => {
    const carrier = await seedBusiness();
    const driverId = meetingKey("driver");
    await seedDriverRow(prisma, carrier, driverId);

    const typeId = await pauseTypeId(prisma, carrier, "REST");

    await prisma.$executeRawUnsafe(
      `INSERT INTO "driver_pause" ("id", "kind", "started_at", "ended_at", "start_submission_id",
         "driverId", "businessId", "occurrenceTypeId", "updated_at")
       VALUES ($1, 'REST', now(), now(), $1, $2, $3, $4, now())`,
      meetingKey("pause"),
      driverId,
      carrier,
      typeId,
    );

    await expect(
      prisma.occurrenceType.delete({ where: { id: typeId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("meeting: data migrations of 20261005120100_occurrence_categories", () => {
  const MIGRATION = "20261005120100_occurrence_categories";

  const typesOf = (client: RawClient, businessId: string) =>
    client.$queryRawUnsafe<
      Array<{
        name: string;
        category: string;
        system_key: string | null;
        pause_kind: string | null;
        requires_receipt_photo: boolean;
        description: string | null;
      }>
    >(
      `SELECT "name", "category"::text AS category, "system_key", "pause_kind"::text AS pause_kind,
              "requires_receipt_photo", "description"
         FROM "occurrence_type" WHERE "businessId" = $1 ORDER BY "name"`,
      businessId,
    );

  it("seeds the four defaults in every company, beside the types it already has", async () => {
    const seed = statementStartingWith(
      MIGRATION,
      `INSERT INTO "occurrence_type"`,
    );

    const outcome = await rolledBack(async (tx) => {
      const carrier = await seedBusiness(tx);

      // The company's own "Refeição", and even a "Refeição (padrão)".
      for (const name of ["Refeição", "Refeição (padrão)", "Cliente ausente"]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "occurrence_type" ("id", "name", "businessId", "blocks_delivery", "updated_at")
           VALUES ($1, $2, $3, true, now())`,
          meetingKey("own"),
          name,
          carrier,
        );
      }

      await tx.$executeRawUnsafe(seed);
      // Idempotent: every company now has every key.
      const second = await tx.$executeRawUnsafe(seed);

      return { second, types: await typesOf(tx, carrier) };
    });

    expect(outcome.second).toBe(0);
    expect(
      outcome.types.map(
        ({
          name,
          category,
          system_key,
          pause_kind,
          requires_receipt_photo,
        }) => ({
          name,
          category,
          system_key,
          pause_kind,
          requires_receipt_photo,
        }),
      ),
    ).toEqual([
      {
        name: "Cliente ausente",
        category: "NOT_DELIVERED",
        system_key: null,
        pause_kind: null,
        requires_receipt_photo: false,
      },
      {
        name: "Descanso",
        category: "PAUSE",
        system_key: "pause_rest",
        pause_kind: "REST",
        requires_receipt_photo: false,
      },
      {
        name: "Entrega normal",
        category: "DELIVERED",
        system_key: "delivered_default",
        pause_kind: null,
        requires_receipt_photo: true,
      },
      {
        name: "Outra pausa",
        category: "PAUSE",
        system_key: "pause_other",
        pause_kind: "OTHER",
        requires_receipt_photo: false,
      },
      // The company's types are untouched; the default takes the first free name.
      {
        name: "Refeição",
        category: "NOT_DELIVERED",
        system_key: null,
        pause_kind: null,
        requires_receipt_photo: false,
      },
      {
        name: "Refeição (padrão 2)",
        category: "PAUSE",
        system_key: "pause_meal",
        pause_kind: "MEAL",
        requires_receipt_photo: false,
      },
      {
        name: "Refeição (padrão)",
        category: "NOT_DELIVERED",
        system_key: null,
        pause_kind: null,
        requires_receipt_photo: false,
      },
    ]);
  });

  it("writes exactly what ensureDefaultOccurrenceTypes writes for a new company", async () => {
    const seed = statementStartingWith(
      MIGRATION,
      `INSERT INTO "occurrence_type"`,
    );

    const outcome = await rolledBack(async (tx) => {
      const byMigration = await seedBusiness(tx);
      await tx.$executeRawUnsafe(seed);

      const byCode = await seedBusiness(tx);
      const written = await ensureDefaultOccurrenceTypes(tx, byCode);
      const again = await ensureDefaultOccurrenceTypes(tx, byCode);

      return {
        written,
        again,
        migration: await typesOf(tx, byMigration),
        code: await typesOf(tx, byCode),
      };
    });

    expect(outcome.written).toBe(4);
    expect(outcome.again).toBe(0);
    expect(outcome.code).toEqual(outcome.migration);
    expect(outcome.code).toEqual(
      expect.arrayContaining(
        DEFAULT_OCCURRENCE_TYPES.map((type) =>
          expect.objectContaining({
            name: type.name,
            description: type.description,
            category: type.category,
            system_key: type.system_key,
            pause_kind: type.pause_kind,
            requires_receipt_photo: type.requires_receipt_photo,
          }),
        ),
      ),
    );
  });

  it("still seeds a default whose chosen name a company type takes at the same instant", async () => {
    const outcome = await rolledBack(async (tx) => {
      const carrier = await seedBusiness(tx);

      // Deterministic stand-in for the race: right before the default
      // "Refeição" is written, a company type with that exact name appears,
      // as a concurrent save would (BEFORE triggers run ahead of the
      // ON CONFLICT check). Rolled back with the rest.
      await tx.$executeRawUnsafe(
        `CREATE FUNCTION "test_steal_default_name"() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW."system_key" = 'pause_meal' AND NEW."name" = 'Refeição' THEN
             INSERT INTO "occurrence_type" ("id", "businessId", "name", "updated_at")
             VALUES (gen_random_uuid()::text, NEW."businessId", NEW."name", now());
           END IF;
           RETURN NEW;
         END $$`,
      );
      await tx.$executeRawUnsafe(
        `CREATE TRIGGER "test_steal_default_name" BEFORE INSERT ON "occurrence_type"
         FOR EACH ROW EXECUTE FUNCTION "test_steal_default_name"()`,
      );

      const written = await ensureDefaultOccurrenceTypes(tx, carrier);

      return { written, types: await typesOf(tx, carrier) };
    });

    // A target-less ON CONFLICT swallowed the name clash and left pause_meal
    // missing (a 500 on the next pause); the next round takes the next name.
    expect(outcome.written).toBe(DEFAULT_OCCURRENCE_TYPES.length);
    expect(outcome.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Refeição", system_key: null }),
        expect.objectContaining({
          name: "Refeição (padrão)",
          system_key: "pause_meal",
        }),
      ]),
    );
    expect(
      outcome.types.filter((type) => type.system_key !== null),
    ).toHaveLength(DEFAULT_OCCURRENCE_TYPES.length);
  });

  it("links every existing pause to its company's default type of the same nature", async () => {
    const link = statementStartingWith(MIGRATION, `UPDATE "driver_pause"`);
    const guard = statementStartingWith(MIGRATION, "DO $$");

    const outcome = await rolledBack(async (tx) => {
      // Back to the column as the migration found it: added, still empty.
      await tx.$executeRawUnsafe(
        `ALTER TABLE "driver_pause" ALTER COLUMN "occurrenceTypeId" DROP NOT NULL`,
      );

      const carrier = await seedBusiness(tx);
      await ensureDefaultOccurrenceTypes(tx, carrier);

      for (const kind of ["MEAL", "REST", "OTHER"]) {
        const driverId = meetingKey("driver");
        await seedDriverRow(tx, carrier, driverId);
        await tx.$executeRawUnsafe(
          `INSERT INTO "driver_pause" ("id", "kind", "started_at", "ended_at", "start_submission_id",
             "driverId", "businessId", "updated_at")
           VALUES ($1, $2::"DriverPauseKind", now(), now(), $1, $3, $4, now())`,
          `pause-${kind}-${carrier}`,
          kind,
          driverId,
          carrier,
        );
      }

      const first = await tx.$executeRawUnsafe(link);
      const second = await tx.$executeRawUnsafe(link);
      await tx.$executeRawUnsafe(guard);

      const rows = await tx.$queryRawUnsafe<
        Array<{ kind: string; system_key: string }>
      >(
        `SELECT p."kind"::text AS kind, t."system_key"
           FROM "driver_pause" p JOIN "occurrence_type" t ON t."id" = p."occurrenceTypeId"
          WHERE p."businessId" = $1 ORDER BY p."kind"`,
        carrier,
      );

      return { first, second, rows };
    });

    expect(outcome.first).toBe(3);
    expect(outcome.second).toBe(0);
    expect(outcome.rows).toEqual([
      { kind: "MEAL", system_key: "pause_meal" },
      { kind: "REST", system_key: "pause_rest" },
      { kind: "OTHER", system_key: "pause_other" },
    ]);
  });

  it("aborts, naming the pause, when a company has no default to link it to", async () => {
    const link = statementStartingWith(MIGRATION, `UPDATE "driver_pause"`);
    const guard = statementStartingWith(MIGRATION, "DO $$");

    const failure = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(
        `ALTER TABLE "driver_pause" ALTER COLUMN "occurrenceTypeId" DROP NOT NULL`,
      );

      const carrier = await seedBusiness(tx);
      const driverId = meetingKey("driver");
      await seedDriverRow(tx, carrier, driverId);
      await tx.$executeRawUnsafe(
        `INSERT INTO "driver_pause" ("id", "kind", "started_at", "start_submission_id",
           "driverId", "businessId", "updated_at")
         VALUES ('pause-without-default', 'MEAL', now(), 'start', $1, $2, now())`,
        driverId,
        carrier,
      );

      await tx.$executeRawUnsafe(link);

      return tx.$executeRawUnsafe(guard).then(
        () => null,
        (error: Error) => error.message,
      );
    });

    expect(failure).toContain(
      "driver_pause sem tipo de pausa padrão da empresa",
    );
    expect(failure).toContain("pause-without-default");
  });

  it("dates the deactivation of inactive types and the release of routes that left", async () => {
    const deactivate = statementStartingWith(
      MIGRATION,
      `UPDATE "occurrence_type"`,
    );
    const release = statementStartingWith(MIGRATION, `UPDATE "route"`);

    const outcome = await rolledBack(async (tx) => {
      const carrier = await seedBusiness(tx);

      await tx.$executeRawUnsafe(
        `INSERT INTO "occurrence_type" ("id", "name", "businessId", "is_active", "updated_at")
         VALUES ('type-off', 'Desativado', $1, false, '2026-09-01 12:00'),
                ('type-on', 'Ativo', $1, true, '2026-09-01 12:00')`,
        carrier,
      );

      const driverId = meetingKey("driver");
      await seedDriverRow(tx, carrier, driverId);

      for (const [id, code, status, startedAt] of [
        ["route-planned", 1, "PLANNED", null],
        ["route-released", 2, "RELEASED", null],
        ["route-running", 3, "IN_PROGRESS", "2026-10-01 08:00"],
        ["route-cancelled-home", 4, "CANCELLED", null],
        ["route-cancelled-street", 5, "CANCELLED", "2026-10-01 09:00"],
      ] as const) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "route" ("id", "code", "scheduled_date", "status", "started_at",
             "businessId", "driverId", "updated_at")
           VALUES ($1, $2, '2026-10-01', $3::"RouteStatus", $4::timestamp, $5, $6, '2026-10-01 07:00')`,
          id,
          code,
          status,
          startedAt,
          carrier,
          driverId,
        );
      }

      await tx.$executeRawUnsafe(deactivate);
      await tx.$executeRawUnsafe(release);
      const again = [
        await tx.$executeRawUnsafe(deactivate),
        await tx.$executeRawUnsafe(release),
      ];

      const types = await tx.$queryRawUnsafe<
        Array<{ id: string; deactivated_at: Date | null }>
      >(
        `SELECT "id", "deactivated_at" FROM "occurrence_type" WHERE "businessId" = $1 ORDER BY "id"`,
        carrier,
      );
      const routes = await tx.$queryRawUnsafe<
        Array<{ id: string; released_at: Date | null }>
      >(
        `SELECT "id", "released_at" FROM "route" WHERE "businessId" = $1 ORDER BY "code"`,
        carrier,
      );

      return { again, types, routes };
    });

    expect(outcome.again).toEqual([0, 0]);
    expect(outcome.types).toEqual([
      { id: "type-off", deactivated_at: new Date("2026-09-01T12:00:00.000Z") },
      { id: "type-on", deactivated_at: null },
    ]);
    expect(outcome.routes).toEqual([
      { id: "route-planned", released_at: null },
      {
        id: "route-released",
        released_at: new Date("2026-10-01T07:00:00.000Z"),
      },
      {
        id: "route-running",
        released_at: new Date("2026-10-01T08:00:00.000Z"),
      },
      { id: "route-cancelled-home", released_at: null },
      {
        id: "route-cancelled-street",
        released_at: new Date("2026-10-01T09:00:00.000Z"),
      },
    ]);
  });
});

describe("meeting: data migration of 20261005120300_proof_model_icp", () => {
  it("marks the documents generated before the signature as LEGACY, once, without touching updated_at", async () => {
    const legacy = statementStartingWith(
      "20261005120300_proof_model_icp",
      `UPDATE "delivery_proof_document"`,
    );

    const outcome = await rolledBack(async (tx) => {
      const carrier = await seedBusiness(tx);

      for (const [id, status] of [
        ["doc-old", "UNSIGNED"],
        ["doc-signed", "SIGNED"],
      ] as const) {
        await seedDeliveryRow(
          tx,
          carrier,
          `delivery-${id}`,
          "Destinatário",
          null,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "delivery_proof_document" ("id", "deliveryId", "storage_key", "sha256",
             "verification_token", "size_bytes", "businessId", "signature_status", "updated_at")
           VALUES ($1, $2, 'k', 'h', $1, 10, $3, $4::"ProofSignatureStatus", '2026-09-30 10:00')`,
          id,
          `delivery-${id}`,
          carrier,
          status,
        );
      }

      const first = await tx.$executeRawUnsafe(legacy);
      const second = await tx.$executeRawUnsafe(legacy);

      const rows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          unsigned_reason: string | null;
          layout_version: number;
          updated_at: Date;
        }>
      >(
        `SELECT "id", "unsigned_reason"::text AS unsigned_reason, "layout_version", "updated_at"
           FROM "delivery_proof_document" WHERE "businessId" = $1 ORDER BY "id"`,
        carrier,
      );

      return { first, second, rows };
    });

    expect(outcome.first).toBeGreaterThanOrEqual(1);
    expect(outcome.second).toBe(0);
    expect(outcome.rows).toEqual([
      {
        id: "doc-old",
        unsigned_reason: "LEGACY",
        layout_version: 1,
        updated_at: new Date("2026-09-30T10:00:00.000Z"),
      },
      {
        id: "doc-signed",
        unsigned_reason: null,
        layout_version: 1,
        updated_at: new Date("2026-09-30T10:00:00.000Z"),
      },
    ]);
  });
});

describe("meeting: one OPEN ticket per delivery and per route (14.5)", () => {
  it("refuses a second open DELIVERY ticket for a delivery, and accepts one after the first closes", async () => {
    const outcome = await rolledBack(async (tx) => {
      const carrier = await seedBusiness(tx);
      const driverId = meetingKey("driver");
      await seedDriverRow(tx, carrier, driverId);
      await seedDeliveryRow(
        tx,
        carrier,
        "ticket-delivery",
        "Mercado Sol",
        driverId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "chat_thread" ("id", "businessId", "driverId", "updated_at")
         VALUES ('ticket-thread', $1, $2, now())`,
        carrier,
        driverId,
      );

      const open = (id: string, number: number, status: "OPEN" | "CLOSED") =>
        tx.$executeRawUnsafe(
          `INSERT INTO "support_ticket" ("id", "number", "kind", "status", "subject", "businessId",
             "threadId", "driverId", "deliveryId", "opened_via", "updated_at")
           VALUES ($1, $2, 'DELIVERY', $3::"SupportTicketStatus", 'Assunto', $4, 'ticket-thread', $5,
             'ticket-delivery', 'PANEL', now())`,
          id,
          number,
          status,
          carrier,
          driverId,
        );

      await open("ticket-closed", 1, "CLOSED");
      await open("ticket-open", 2, "OPEN");

      return open("ticket-open-again", 3, "OPEN").then(
        () => null,
        (error: Error) => error.message,
      );
    });

    expect(outcome).toMatch(
      /Key \("deliveryId"\)=\(ticket-delivery\) already exists/,
    );
  });
});

describe("meeting: the conversations become tickets (20261005120600)", () => {
  const MIGRATION = "20261005120600_support_tickets_backfill";

  /** The chat as the pre-ticket release left it, for one company. */
  async function seedChat(tx: RawClient) {
    const carrier = await seedBusiness(tx);
    const k = (name: string) => `${name}-${carrier}`;

    for (const driver of ["d1", "d2", "d3", "d4"])
      await seedDriverRow(tx, carrier, k(driver));
    await seedUserRow(tx, carrier, k("staff"));
    await seedUserRow(tx, carrier, k("u-d1"), k("d1"));
    await seedUserRow(tx, carrier, k("u-d2"), k("d2"));
    await seedUserRow(tx, carrier, k("u-d4"), k("d4"));

    await seedDeliveryRow(tx, carrier, k("del1"), "Mercado Sol", k("d1"));
    await seedDeliveryRow(tx, carrier, k("del2"), "Sem motorista", null);
    await seedDeliveryRow(tx, carrier, k("del3"), "Loja Lua", k("d3"));

    await tx.$executeRawUnsafe(
      `INSERT INTO "occurrence_type" ("id", "name", "businessId", "requires_authorization", "updated_at")
       VALUES ($1, 'Cliente ausente', $2, true, now())`,
      k("type"),
      carrier,
    );

    for (const [id, delivery, status, reporter, createdAt] of [
      ["o1", "del1", "PENDING", "u-d1", "now() - interval '2 hours'"],
      ["o2", "del2", "PENDING", "staff", "now() - interval '90 minutes'"],
      ["o3", "del1", "APPROVED", "u-d1", "now() - interval '80 minutes'"],
      ["o4", "del3", "PENDING", "staff", "now() - interval '1 hour'"],
    ] as const) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "delivery_occurrence" ("id", "deliveryId", "occurrenceTypeId", "reportedById",
           "businessId", "authorization_status", "created_at", "updated_at")
         VALUES ($1, $2, $3, $4, $5, $6::"OccurrenceAuthorizationStatus", ${createdAt}, now())`,
        k(id),
        k(delivery),
        k("type"),
        k(reporter),
        carrier,
        status,
      );
    }

    // th1: the driver spoke last, an hour ago (somebody is waiting).
    // th2: the staff spoke last. th4: only a mass notice.
    for (const [thread, driver] of [
      ["th1", "d1"],
      ["th2", "d2"],
      ["th4", "d4"],
    ]) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "chat_thread" ("id", "businessId", "driverId", "updated_at")
         VALUES ($1, $2, $3, now())`,
        k(thread),
        carrier,
        k(driver),
      );
    }

    for (const [id, thread, sender, delivery, broadcast, createdAt] of [
      ["m1", "th1", "staff", null, null, "now() - interval '3 hours'"],
      ["m2", "th1", "u-d1", "del1", null, "now() - interval '1 hour'"],
      ["m3", "th1", "staff", null, "bc", "now() - interval '30 minutes'"],
      ["m4", "th2", "u-d2", null, null, "now() - interval '2 days'"],
      ["m5", "th2", "staff", null, null, "now() - interval '1 day'"],
      ["m6", "th2", "staff", null, "bc", "now() - interval '30 minutes'"],
      ["m7", "th4", "staff", null, "bc", "now() - interval '30 minutes'"],
    ] as const) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "chat_message" ("id", "kind", "body", "threadId", "senderId", "deliveryId",
           "broadcast_id", "created_at")
         VALUES ($1, 'TEXT', 'texto', $2, $3, $4, $5, ${createdAt})`,
        k(id),
        k(thread),
        k(sender),
        delivery ? k(delivery) : null,
        broadcast ? k(broadcast) : null,
      );
    }

    await tx.$executeRawUnsafe(
      `INSERT INTO "chat_thread_read" ("id", "threadId", "userId", "last_read_at", "updated_at")
       VALUES ($1, $2, $3, '2026-10-05 10:00', now()), ($4, $2, $5, '2026-10-05 11:00', now())`,
      k("read-staff"),
      k("th1"),
      k("staff"),
      k("read-driver"),
      k("u-d1"),
    );

    return { carrier, k };
  }

  async function runBackfill(tx: RawClient) {
    for (const statement of migrationStatements(MIGRATION)) {
      await tx.$executeRawUnsafe(statement);
    }
  }

  async function ticketsOf(tx: RawClient, carrier: string) {
    return tx.$queryRawUnsafe<
      Array<{
        id: string;
        number: number;
        kind: string;
        status: string;
        subject: string;
        threadId: string;
        driverId: string;
        deliveryId: string | null;
        occurrenceId: string | null;
        close_outcome: string | null;
        has_closed_at: boolean;
        closedById: string | null;
        last_message_at: Date | null;
        last_driver_is_last: boolean | null;
        first_staff_reply_at: Date | null;
      }>
    >(
      `SELECT "id", "number", "kind"::text AS kind, "status"::text AS status, "subject",
              "threadId", "driverId", "deliveryId", "occurrenceId",
              "close_outcome"::text AS close_outcome, "closed_at" IS NOT NULL AS has_closed_at,
              "closedById", "last_message_at",
              "last_driver_message_at" = "last_message_at" AS last_driver_is_last,
              "first_staff_reply_at"
         FROM "support_ticket" WHERE "businessId" = $1 ORDER BY "number"`,
      carrier,
    );
  }

  it("gives every conversation a LEGACY ticket and every pending request its ticket, numbered per company", async () => {
    const outcome = await rolledBack(async (tx) => {
      const { carrier, k } = await seedChat(tx);
      await runBackfill(tx);

      const tickets = await ticketsOf(tx, carrier);
      const messages = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          ticket: number | null;
          same_thread: boolean | null;
        }>
      >(
        `SELECT m."id", t."number" AS ticket, t."threadId" = m."threadId" AS same_thread
           FROM "chat_message" m
           JOIN "chat_thread" th ON th."id" = m."threadId"
           LEFT JOIN "support_ticket" t ON t."id" = m."ticketId"
          WHERE th."businessId" = $1 ORDER BY m."id"`,
        carrier,
      );
      const reads = await tx.$queryRawUnsafe<
        Array<{ number: number; userId: string; last_read_at: Date }>
      >(
        `SELECT t."number", r."userId", r."last_read_at"
           FROM "support_ticket_read" r JOIN "support_ticket" t ON t."id" = r."ticketId"
          WHERE t."businessId" = $1 ORDER BY r."userId"`,
        carrier,
      );
      const events = await tx.$queryRawUnsafe<
        Array<{
          number: number;
          type: string;
          actor_kind: string;
          outcome: string | null;
        }>
      >(
        `SELECT t."number", e."type"::text AS type, e."actor_kind"::text AS actor_kind,
                e."outcome"::text AS outcome
           FROM "support_ticket_event" e JOIN "support_ticket" t ON t."id" = e."ticketId"
          WHERE e."businessId" = $1 ORDER BY t."number", e."type"`,
        carrier,
      );
      const [counter] = await tx.$queryRawUnsafe<
        Array<{ last_number: number }>
      >(
        `SELECT "last_number" FROM "support_ticket_counter" WHERE "businessId" = $1`,
        carrier,
      );
      const threads = await tx.$queryRawUnsafe<Array<{ driverId: string }>>(
        `SELECT "driverId" FROM "chat_thread" WHERE "businessId" = $1 ORDER BY "driverId"`,
        carrier,
      );

      return { k, tickets, messages, reads, events, counter, threads };
    });

    const { k } = outcome;

    expect(
      outcome.tickets.map(
        ({
          number,
          kind,
          status,
          subject,
          threadId,
          driverId,
          deliveryId,
          occurrenceId,
          close_outcome,
          has_closed_at,
          closedById,
        }) => ({
          number,
          kind,
          status,
          subject,
          threadId,
          driverId,
          deliveryId,
          occurrenceId,
          close_outcome,
          has_closed_at,
          closedById,
        }),
      ),
    ).toEqual([
      // The conversation that began first (two days ago), answered by the
      // staff: closed by the migration, by nobody.
      {
        number: 1,
        kind: "LEGACY",
        status: "CLOSED",
        subject: "Conversa anterior aos atendimentos",
        threadId: k("th2"),
        driverId: k("d2"),
        deliveryId: null,
        occurrenceId: null,
        close_outcome: "MIGRATED",
        has_closed_at: true,
        closedById: null,
      },
      // The driver is waiting for an answer: it stays open.
      {
        number: 2,
        kind: "LEGACY",
        status: "OPEN",
        subject: "Conversa anterior aos atendimentos",
        threadId: k("th1"),
        driverId: k("d1"),
        deliveryId: null,
        occurrenceId: null,
        close_outcome: null,
        has_closed_at: false,
        closedById: null,
      },
      // The pending requests, oldest first, on their driver's channel. The
      // one without a driver (o2) and the decided one (o3) get none.
      {
        number: 3,
        kind: "OCCURRENCE",
        status: "OPEN",
        subject: "Cliente ausente — Mercado Sol",
        threadId: k("th1"),
        driverId: k("d1"),
        deliveryId: k("del1"),
        occurrenceId: k("o1"),
        close_outcome: null,
        has_closed_at: false,
        closedById: null,
      },
      {
        number: 4,
        kind: "OCCURRENCE",
        status: "OPEN",
        subject: "Cliente ausente — Loja Lua",
        threadId: expect.any(String),
        driverId: k("d3"),
        deliveryId: k("del3"),
        occurrenceId: k("o4"),
        close_outcome: null,
        has_closed_at: false,
        closedById: null,
      },
    ]);

    // th1's ordering columns come from its messages, broadcast left out.
    const waiting = outcome.tickets[1];
    expect(waiting.last_driver_is_last).toBe(true);
    expect(waiting.first_staff_reply_at).not.toBeNull();

    // Every non-broadcast message is in its own thread's LEGACY ticket; the
    // mass notices stay outside tickets.
    expect(outcome.messages).toEqual([
      { id: k("m1"), ticket: 2, same_thread: true },
      { id: k("m2"), ticket: 2, same_thread: true },
      { id: k("m3"), ticket: null, same_thread: null },
      { id: k("m4"), ticket: 1, same_thread: true },
      { id: k("m5"), ticket: 1, same_thread: true },
      { id: k("m6"), ticket: null, same_thread: null },
      { id: k("m7"), ticket: null, same_thread: null },
    ]);

    // The cursors carried over, at the same instant: no false unread counts.
    expect(outcome.reads).toEqual([
      {
        number: 2,
        userId: k("staff"),
        last_read_at: new Date("2026-10-05T10:00:00.000Z"),
      },
      {
        number: 2,
        userId: k("u-d1"),
        last_read_at: new Date("2026-10-05T11:00:00.000Z"),
      },
    ]);

    expect(outcome.events).toEqual([
      { number: 1, type: "OPENED", actor_kind: "SYSTEM", outcome: null },
      { number: 1, type: "CLOSED", actor_kind: "SYSTEM", outcome: "MIGRATED" },
      { number: 2, type: "OPENED", actor_kind: "SYSTEM", outcome: null },
      { number: 3, type: "OPENED", actor_kind: "SYSTEM", outcome: null },
      { number: 4, type: "OPENED", actor_kind: "SYSTEM", outcome: null },
    ]);

    expect(outcome.counter).toEqual({ last_number: 4 });
    // d3 had no channel: the request's ticket created it.
    expect(outcome.threads.map((thread) => thread.driverId)).toEqual(
      [k("d1"), k("d2"), k("d3"), k("d4")].sort(),
    );
  });

  it("is idempotent: a second run creates, moves and copies nothing", async () => {
    const outcome = await rolledBack(async (tx) => {
      const { carrier } = await seedChat(tx);

      const snapshot = async () =>
        tx.$queryRawUnsafe<
          Array<{
            tickets: bigint;
            events: bigint;
            reads: bigint;
            ticketed: bigint;
          }>
        >(
          `SELECT (SELECT count(*) FROM "support_ticket" WHERE "businessId" = $1) AS tickets,
                  (SELECT count(*) FROM "support_ticket_event" WHERE "businessId" = $1) AS events,
                  (SELECT count(*) FROM "support_ticket_read" r JOIN "support_ticket" t ON t."id" = r."ticketId"
                    WHERE t."businessId" = $1) AS reads,
                  (SELECT count(*) FROM "chat_message" m JOIN "support_ticket" t ON t."id" = m."ticketId"
                    WHERE t."businessId" = $1) AS ticketed`,
          carrier,
        );

      await runBackfill(tx);
      const first = await snapshot();
      const firstTickets = await ticketsOf(tx, carrier);

      await runBackfill(tx);
      const second = await snapshot();
      const secondTickets = await ticketsOf(tx, carrier);

      return { first, second, firstTickets, secondTickets };
    });

    expect(outcome.first).toEqual([
      { tickets: 4n, events: 5n, reads: 2n, ticketed: 4n },
    ]);
    expect(outcome.second).toEqual(outcome.first);
    expect(outcome.secondTickets).toEqual(outcome.firstTickets);
  });

  it("aborts when a message would end up in another conversation's ticket", async () => {
    const guard = statementStartingWith(MIGRATION, "DO $$");

    const failure = await rolledBack(async (tx) => {
      const { carrier, k } = await seedChat(tx);
      await runBackfill(tx);

      // Corrupt one message as a wrong backfill would.
      await tx.$executeRawUnsafe(
        `UPDATE "chat_message" SET "ticketId" =
           (SELECT "id" FROM "support_ticket" WHERE "businessId" = $1 AND "threadId" = $2 AND "kind" = 'LEGACY')
         WHERE "id" = $3`,
        carrier,
        k("th2"),
        k("m1"),
      );

      return tx.$executeRawUnsafe(guard).then(
        () => null,
        (error: Error) => error.message,
      );
    });

    expect(failure).toContain("mensagens em ticket de outra conversa");
  });
});

describe("meeting: a pause started with its nature alone (the installed app's body)", () => {
  it("lands on the company's seeded type of that nature, seeding the defaults when the company has none", async () => {
    const carrier = await seedBusiness();
    const driverId = meetingKey("driver");
    await seedDriverRow(prisma, carrier, driverId);

    // A company created after the migration, before create-business seeds:
    // no default types at all.
    expect(
      await prisma.occurrenceType.count({
        where: { businessId: carrier, system_key: { not: null } },
      }),
    ).toBe(0);

    const repository = new DriverPauseRepository(prisma);
    const result = await repository.createPause({
      kind: "REST",
      started_at: new Date("2026-10-05T15:00:00.000Z"),
      ended_at: new Date("2026-10-05T15:20:00.000Z"),
      start_submission_id: meetingKey("start"),
      driverId,
      businessId: carrier,
    });

    expect(result.status).toBe("created");

    const stored = await prisma.driverPause.findFirstOrThrow({
      where: { businessId: carrier, driverId },
      select: {
        kind: true,
        occurrenceType: { select: { system_key: true, pause_kind: true } },
      },
    });

    expect(stored).toEqual({
      kind: "REST",
      occurrenceType: { system_key: "pause_rest", pause_kind: "REST" },
    });
    expect(
      await prisma.occurrenceType.count({
        where: { businessId: carrier, system_key: { not: null } },
      }),
    ).toBe(DEFAULT_OCCURRENCE_TYPES.length);
  });
});

const PROOF_BACKFILL = resolve(
  process.cwd(),
  "prisma/backfills/proof-occurrences.sql",
);

describe("meeting: the recorded proofs become DELIVERED occurrences (prisma/backfills)", () => {
  it("is not a migration: migrate deploy must not run it before the readers filter", () => {
    // Design §9.2: an owner-run job after the release whose readers filter
    // occurrences by category; as a migration it would ship with the image
    // that shows every past proof as an occurrence.
    const migrations = readdirSync(resolve(process.cwd(), "prisma/migrations"));

    expect(
      migrations.filter((name) => name.includes("proof_occurrences")),
    ).toEqual([]);
    expect(sqlStatements(PROOF_BACKFILL)).toHaveLength(1);
  });

  it("works in batches of 1,000 until it writes nothing", async () => {
    const [backfill] = sqlStatements(PROOF_BACKFILL);

    const runs = await rolledBack(async (tx) => {
      const carrier = await seedBusiness(tx);
      await ensureDefaultOccurrenceTypes(tx, carrier);

      const author = meetingKey("author");
      await seedUserRow(tx, carrier, author);
      await seedDeliveryRow(
        tx,
        carrier,
        `delivery-${author}`,
        "Mercado Lua",
        null,
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO "delivery_event" ("id", "type", "photo", "deliveryId", "businessId",
           "reportedById", "created_at")
         SELECT 'proof-batch-' || n, 'PROOF', 'proofs/canhoto.jpg', $1, $2, $3, now()
           FROM generate_series(1, 1001) AS n`,
        `delivery-${author}`,
        carrier,
        author,
      );

      const counts: number[] = [];
      for (let run = 0; run < 3; run += 1)
        counts.push(await tx.$executeRawUnsafe(backfill));

      return counts;
    });

    expect(runs).toEqual([1000, 1, 0]);
  });

  it("writes one occurrence per authored proof, links it, skips the unauthored and runs once", async () => {
    const [backfill] = sqlStatements(PROOF_BACKFILL);

    const outcome = await rolledBack(async (tx) => {
      const carrier = await seedBusiness(tx);
      await ensureDefaultOccurrenceTypes(tx, carrier);

      const author = meetingKey("author");
      await seedUserRow(tx, carrier, author);
      await seedDeliveryRow(
        tx,
        carrier,
        `delivery-${author}`,
        "Mercado Sol",
        null,
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO "delivery_event" ("id", "type", "photo", "signature", "received_by",
           "latitude", "longitude", "deliveryId", "businessId", "reportedById", "occurred_at", "created_at")
         VALUES ('proof-authored', 'PROOF', 'proofs/canhoto.jpg', 'proofs/assinatura.png', 'João',
                 -23.5, -46.6, $1, $2, $3, '2026-10-05 09:00', '2026-10-05 09:05'),
                ('proof-unauthored', 'PROOF', 'proofs/outro.jpg', NULL, NULL,
                 NULL, NULL, $1, $2, NULL, NULL, '2026-10-05 10:00'),
                ('arrival', 'ARRIVAL', NULL, NULL, NULL,
                 NULL, NULL, $1, $2, $3, NULL, '2026-10-05 08:55')`,
        `delivery-${author}`,
        carrier,
        author,
      );

      const first = await tx.$executeRawUnsafe(backfill);
      const second = await tx.$executeRawUnsafe(backfill);

      const rows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          category: string | null;
          system_key: string | null;
          reportedById: string | null;
          receipt_photo: string | null;
          signature: string | null;
          received_by: string | null;
          latitude: number | null;
          occurred_at: Date | null;
          created_at: Date | null;
          authorization_status: string | null;
          client_submission_id: string | null;
        }>
      >(
        `SELECT e."id", o."category"::text AS category, t."system_key", o."reportedById",
                o."receipt_photo", o."signature", o."received_by", o."latitude",
                o."occurred_at", o."created_at", o."authorization_status"::text AS authorization_status,
                o."client_submission_id"
           FROM "delivery_event" e
           LEFT JOIN "delivery_occurrence" o ON o."id" = e."occurrenceId"
           LEFT JOIN "occurrence_type" t ON t."id" = o."occurrenceTypeId"
          WHERE e."businessId" = $1 ORDER BY e."id"`,
        carrier,
      );

      return { first, second, rows, author };
    });

    expect(outcome.first).toBe(1);
    expect(outcome.second).toBe(0);
    expect(outcome.rows).toEqual([
      expect.objectContaining({ id: "arrival", category: null }),
      {
        id: "proof-authored",
        category: "DELIVERED",
        system_key: "delivered_default",
        reportedById: outcome.author,
        receipt_photo: "proofs/canhoto.jpg",
        signature: "proofs/assinatura.png",
        received_by: "João",
        latitude: -23.5,
        occurred_at: new Date("2026-10-05T09:00:00.000Z"),
        created_at: new Date("2026-10-05T09:05:00.000Z"),
        authorization_status: "NOT_REQUIRED",
        client_submission_id: null,
      },
      // No author: skipped, not invented.
      expect.objectContaining({ id: "proof-unauthored", category: null }),
    ]);
  });
});
