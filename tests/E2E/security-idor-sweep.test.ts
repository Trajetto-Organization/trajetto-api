import { afterAll, beforeAll, describe, expect, it } from "vitest";

import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { APP_BOOT_TIMEOUT_MS } from "../support/app-boot";
import {
  SECRET_MARKER,
  seedSweepCarrier,
  sweepToken,
  type CarrierIds,
} from "./support/idor-sweep-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The IDOR sweep, built from the OpenAPI document instead of by hand.
 *
 * The hand-written cross-tenant files cover the routes somebody remembered.
 * This one walks EVERY operation the API publishes and, for every place a
 * record id can go — path, query or body, nested arrays included — sends the
 * same request twice: once with the id of a row that belongs to another
 * company, once with an id that exists nowhere. Every other id in the request
 * is a real row of the caller's own company, so the request gets as far as
 * the lookup being probed instead of dying on the first id.
 *
 * What has to hold, for the company administrator, the company's driver and
 * an API key with every scope:
 *
 *   - the two answers are the same (status, code and message, with the ids
 *     normalised): "another company's row" must be indistinguishable from
 *     "no such row", or the API is an oracle for which ids exist;
 *   - no answer carries any text of the other company's rows;
 *   - no answer is a 5xx;
 *   - afterwards, not one row of the other company changed.
 *
 * A route added tomorrow is swept tomorrow, with no edit here, unless its id
 * slot has a name this file does not know — which the coverage test below
 * turns into a failure that names it.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let redis: Redis;

let A: CarrierIds;
let B: CarrierIds;

const tokens: Record<Actor, string> = { admin: "", driver: "", apiKey: "" };
const actorUserIds: string[] = [];

type Actor = "admin" | "driver" | "apiKey";

interface Operation {
  method: string;
  path: string;
  parameters?: Array<{
    in: string;
    name: string;
    required?: boolean;
    schema?: JsonSchema;
  }>;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  security?: unknown[];
}

interface JsonSchema {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minimum?: number;
  exclusiveMinimum?: number | boolean;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  nullable?: boolean;
  pattern?: string;
}

/**
 * Which seeded row a field name points at. Explicit on purpose: a regex on
 * "ends with id" also matched `driver_license_valid`, and a slot this table
 * does not know must fail the coverage test, not be guessed.
 */
const ENTITY_BY_NAME: Record<string, string> = {
  businessId: "businessId",
  deliveryId: "deliveryId",
  deliveryIds: "looseDeliveryId",
  routeId: "routeId",
  excludeRouteId: "routeId",
  stopId: "stopId",
  stopIds: "stopId",
  orderedStopIds: "stopId",
  driverId: "driverId",
  driverIds: "driverId",
  vehicleId: "vehicleId",
  shipperId: "shipperId",
  shipperIds: "shipperId",
  shipper_id: "shipperId",
  occurrenceTypeId: "occurrenceTypeId",
  occurrence_type_id: "occurrenceTypeId",
  start_submission_id: "pauseSubmissionId",
  branchId: "branchId",
  supplierId: "supplierId",
  partId: "partId",
  fuelTypeId: "fuelTypeId",
  vehicleTypeId: "vehicleTypeId",
  profileAccessId: "profileAccessId",
  permissionId: "permissionId",
  userId: "userId",
  masterUserId: "userId",
  responsibleUserId: "userId",
  registrationUserId: "userId",
  assignedUserId: "userId",
  assigneeId: "userId",
  expectedAssigneeId: "userId",
  serviceOrderId: "serviceOrderId",
  serviceOrderPartId: "serviceOrderPartId",
  accountPayableId: "accountPayableId",
  checklistId: "checklistId",
  fineId: "fineId",
  fuelId: "fuelId",
  columnId: "columnId",
  cardId: "cardId",
  notificationId: "notificationId",
  reasonId: "reasonId",
  importId: "importId",
  auditId: "auditId",
  occurrenceId: "occurrenceId",
  ticketId: "ticketId",
  threadId: "threadId",
  messageId: "messageId",
  beforeId: "messageId",
  afterId: "messageId",
  aroundMessageId: "messageId",
  apiKeyId: "apiKeyId",
  endpointId: "endpointId",
  recordId: "fuelId",
};

/** The driver's own rows are the ones of its day on the street. */
const DRIVER_OWN: Record<string, string> = {
  deliveryId: "driverDeliveryId",
  routeId: "journeyRouteId",
  stopId: "journeyStopId",
};

/** `{id}` and `[].id` mean a different row on each route family. */
function entityForGenericId(
  path: string,
  location: string,
): string | undefined {
  if (location.includes("cards")) return "cardId";
  if (location.includes("columns")) return "columnId";
  if (path.startsWith("/integration/v1/deliveries")) return "deliveryId";
  if (path.startsWith("/integration/v1/routes")) return "routeId";
  if (path.startsWith("/integrations/api-key")) return "apiKeyId";
  if (path.startsWith("/integrations/webhook-endpoint")) return "endpointId";
  if (path.startsWith("/integrations/webhook-delivery"))
    return "webhookDeliveryId";
  return undefined;
}

/**
 * Names that end in "id" and are NOT references to a row: idempotency keys
 * the client mints, a device fingerprint, a fleet number, the global traffic
 * code table. Filled with a fresh value and never probed.
 */
const NOT_A_REFERENCE = new Set([
  "client_submission_id",
  "clientSubmissionId",
  "end_submission_id",
  "device_id",
  "fleet_id",
  "trafficViolationCodeId",
  "quoteId",
  "driver_license_valid",
  "vehicle_documents_valid",
  "insurance_valid",
  "fire_extinguisher_valid",
  "amount_paid",
  // Cursor halves: each travels with its timestamp, and the thread or ticket
  // in the same request is the slot that names the tenant.
  "beforeId",
  "afterId",
]);

function looksLikeReference(name: string): boolean {
  return /(Id|Ids|_id)$/.test(name) || name === "id";
}

/**
 * Values that pass the field's own rule, so the request reaches the id
 * lookup instead of stopping at validation (the run prints how many still
 * stop there).
 */
const STRING_HINTS: Record<string, string> = {
  birth_date: "1990-01-01",
  cnh: "12345678900",
  rg: "123456789",
  renavam: "12345678901",
  address_number: "1",
  role: "BUSINESS_USER",
  body: "Mensagem da varredura",
  code: "123456",
  acquisition_date: "2020-01-01",
  manufacturing_year: "2020-01-01",
  model_year: "2020-01-01",
};

const NUMBER_HINTS: Record<string, number> = {
  unit_price: 10,
  amount: 100,
  total_amount: 100,
  maintenance_interval_km: 10_000,
  maintenance_interval_km_at_service: 10_000,
  maintenance_interval_months: 6,
  current_mileage: 2_000,
  current_mileage_at_service: 2_000,
  km_per_liter: 3,
  number_of_axles: 2,
  quantity: 1,
  latitude: -23.55,
  longitude: -46.63,
};

interface Variant {
  omit?: string[];
  set?: Record<string, unknown>;
}

/**
 * Bodies whose fields exclude each other: one variant per legal shape, so
 * every id slot is probed in a request the use case actually accepts.
 */
const VARIANTS: Record<string, Variant[]> = {
  "POST /user/create-user": [
    { omit: ["driverId"], set: { role: "BUSINESS_USER" } },
    {
      omit: ["profileAccessId"],
      set: { role: "BUSINESS_USER", userType: "driver" },
    },
  ],
  "PATCH /user/update-user/{userId}": [
    { omit: ["driverId"] },
    { omit: ["profileAccessId"], set: { userType: "driver" } },
  ],
  "PATCH /user/update-master-user/{masterUserId}": [
    { set: { name: "Novo nome" } },
  ],
  "PATCH /status-change-reason/update-status-change-reason/{reasonId}/business/{businessId}":
    [{ set: { name: "Novo nome" } }],
  "PATCH /route/set-delivery-location/{deliveryId}/business/{businessId}": [
    { set: { latitude: -23.55, longitude: -46.63 } },
  ],
  // One context per ticket: a delivery, a route or an occurrence.
  "POST /chat/tickets": [
    { omit: ["routeId", "occurrenceId"] },
    { omit: ["deliveryId", "occurrenceId"] },
    { omit: ["deliveryId", "routeId"] },
  ],
  // The anchor message and the filters each narrow the same page: one at a
  // time, so a refusal on one does not hide the others.
  "GET /chat/list-messages": [
    { omit: ["aroundMessageId", "deliveryId", "routeId", "ticketId"] },
    { omit: ["threadId", "driverId", "deliveryId", "routeId", "ticketId"] },
  ],
  "POST /fuel/create-fuel/{businessId}": [
    { set: { latitude: -23.55, longitude: -46.63 } },
  ],
  "POST /chat/tickets/{ticketId}/messages": [
    { set: { body: "Mensagem da varredura" } },
  ],
  "PATCH /permission/update-permission/{permissionId}": [
    { set: { canRead: true } },
  ],
  // A fresh submission per request: a reused one is an idempotent replay.
  "POST /driver-pause/start/{businessId}": [
    { set: { start_submission_id: () => randomUUID() } },
  ],
  "POST /chat/send-message": [
    { omit: ["audience"], set: { body: "Mensagem da varredura" } },
  ],
  "PUT /integrations/webhook-endpoint/{id}/business/{businessId}": [
    { set: { topics: ["delivery.created"] } },
  ],
};

/** Path parameters that are not ids at all. */
const FIXED_PATH_VALUES: Record<string, string> = {
  module: "FLEET",
  recordType: "fuel",
  // Quotes are the platform's own leads, not a tenant's rows.
  quoteId: randomUUID(),
};

/** Not session-authenticated, or tokenised by a link — out of this sweep. */
function isSkipped(op: Operation): boolean {
  if (!op.security?.length) return true;
  if (op.path.startsWith("/health")) return true;
  if (op.path.startsWith("/docs")) return true;
  return false;
}

type Mode =
  | { kind: "base" }
  | { kind: "probe"; slot: number; with: "victim" | "missing" };

interface Slot {
  index: number;
  location: string;
  name: string;
  entity: string;
}

interface Built {
  url: string;
  body: unknown;
  slots: Slot[];
  unknownSlots: string[];
  probeValue?: string;
}

const MISSING_IDS = new Map<number, string>();

/**
 * Walks one operation and builds its request. Every id slot met is numbered
 * in traversal order (deterministic for a given operation), so the probe of
 * slot N changes slot N only.
 */
function build(
  op: Operation,
  mode: Mode,
  actor: Actor,
  variant: Variant = {},
): Built {
  const slots: Slot[] = [];
  const unknownSlots: string[] = [];
  let probeValue: string | undefined;

  const own = A;

  const idFor = (location: string, name: string): string => {
    const entity =
      name === "id" || location.endsWith("[].id")
        ? entityForGenericId(op.path, location)
        : name === "occurrence_type_id" && op.path.startsWith("/driver-pause")
          ? "pauseTypeId"
          : name === "start_submission_id" &&
              op.path.startsWith("/driver-pause/start")
            ? undefined
            : ENTITY_BY_NAME[name];

    if (!entity) {
      unknownSlots.push(`${location}`);
      return randomUUID();
    }

    const index = slots.length;
    slots.push({ index, location, name, entity });

    if (mode.kind === "probe" && mode.slot === index) {
      if (mode.with === "victim") {
        probeValue = B[entity];
        return B[entity];
      }

      let missing = MISSING_IDS.get(index);
      if (!missing) {
        missing = randomUUID();
        MISSING_IDS.set(index, missing);
      }
      probeValue = missing;
      return missing;
    }

    // The driver works its released route of the day, not the plan.
    if (actor === "driver" && DRIVER_OWN[entity])
      return own[DRIVER_OWN[entity]];

    return own[entity];
  };

  const sample = (
    schema: JsonSchema | undefined,
    name: string,
    location: string,
  ): unknown => {
    if (!schema) return undefined;

    if (schema.allOf?.length) {
      return sample(
        schema.allOf.reduce<JsonSchema>(
          (merged, part) => ({
            ...merged,
            ...part,
            properties: { ...merged.properties, ...part.properties },
            required: [...(merged.required ?? []), ...(part.required ?? [])],
          }),
          {},
        ),
        name,
        location,
      );
    }

    const variants = schema.anyOf ?? schema.oneOf;
    if (variants?.length) {
      const nonNull =
        variants.find((variant) => variant.type !== "null") ?? variants[0];
      return sample(nonNull, name, location);
    }

    if (schema.const !== undefined) return schema.const;
    if (schema.enum?.length)
      return schema.enum.find((value) => value !== null) ?? schema.enum[0];

    const type = Array.isArray(schema.type)
      ? schema.type.find((candidate) => candidate !== "null")
      : (schema.type ?? (schema.properties ? "object" : undefined));

    if (type === "object") {
      const out: Record<string, unknown> = {};

      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        const required = schema.required?.includes(key) ?? false;
        const reference = !NOT_A_REFERENCE.has(key) && looksLikeReference(key);

        // Optional fields are sent only when they name a row: those are the
        // slots worth probing; the rest only add ways to fail validation.
        if (location === "body" && variant.omit?.includes(key)) continue;

        if (location === "body" && variant.set && key in variant.set) {
          const value = variant.set[key];
          out[key] =
            typeof value === "function" ? (value as () => unknown)() : value;
          continue;
        }

        if (!required && !reference) continue;

        out[key] = sample(child, key, `${location}.${key}`);
      }

      return out;
    }

    if (type === "array") {
      const reference = !NOT_A_REFERENCE.has(name) && looksLikeReference(name);
      const item = schema.items;
      const itemsHaveId = Boolean(item?.properties?.id);

      if (
        !reference &&
        !itemsHaveId &&
        !(schema.minItems && schema.minItems > 0)
      )
        return [];

      return [sample(item, reference ? name : name, `${location}[]`)];
    }

    if (type === "string") {
      if (!NOT_A_REFERENCE.has(name) && looksLikeReference(name)) {
        return idFor(location, name);
      }

      if (schema.format === "uuid") return randomUUID();
      if (schema.format === "date-time") return new Date().toISOString();
      if (schema.format === "date") return "2026-10-07";
      if (schema.format === "email")
        return `sweep-${randomUUID().slice(0, 8)}@exemplo.com.br`;
      if (schema.format === "uri" || schema.format === "url")
        return "https://example.com/sweep";

      const lower = name.toLowerCase();
      let value = "Teste de varredura";

      if (STRING_HINTS[name] !== undefined) return STRING_HINTS[name];

      if (/date|_at$|^from$|^to$|day/.test(lower)) value = "2026-10-07";
      else if (lower.includes("cnpj")) value = "11222333000181";
      else if (lower.includes("cpf")) value = "52998224725";
      else if (lower.includes("plate")) value = "ABC1D23";
      else if (lower.includes("cep")) value = "01001000";
      else if (lower === "uf") value = "SP";
      else if (/phone|telephone/.test(lower)) value = "11999999999";
      else if (lower.includes("color")) value = "#000000";
      else if (lower.includes("month")) value = "2026-10";
      else if (lower.includes("url")) value = "https://example.com/sweep";

      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        value = value.slice(0, schema.maxLength);
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        value = value.padEnd(schema.minLength, "x");
      }

      return value;
    }

    if (type === "integer" || type === "number") {
      const hinted = NUMBER_HINTS[name];
      if (hinted !== undefined) return hinted;

      let value = typeof schema.minimum === "number" ? schema.minimum : 1;
      if (typeof schema.exclusiveMinimum === "number")
        value = schema.exclusiveMinimum + 1;
      if (schema.exclusiveMinimum === true) value += 1;
      if (typeof schema.maximum === "number" && value > schema.maximum)
        value = schema.maximum;
      return value;
    }

    if (type === "boolean") return name === "canRead";

    return undefined;
  };

  // Path first, then query, then body: the numbering order.
  const url = op.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    if (FIXED_PATH_VALUES[name]) return FIXED_PATH_VALUES[name];
    return idFor(`path.${name}`, name);
  });

  const query = new URLSearchParams();

  for (const parameter of op.parameters ?? []) {
    if (parameter.in !== "query") continue;
    if (variant.omit?.includes(parameter.name)) continue;

    const reference =
      !NOT_A_REFERENCE.has(parameter.name) &&
      looksLikeReference(parameter.name);
    if (!parameter.required && !reference) continue;

    const value = sample(
      parameter.schema,
      parameter.name,
      `query.${parameter.name}`,
    );
    if (value === undefined) continue;

    query.set(
      parameter.name,
      Array.isArray(value) ? value.join(",") : String(value),
    );
  }

  const json = op.requestBody?.content?.["application/json"]?.schema;
  const body = json ? sample(json, "", "body") : undefined;

  const search = query.toString();

  return {
    url: search ? `${url}?${search}` : url,
    body,
    slots,
    unknownSlots,
    probeValue,
  };
}

interface Answer {
  status: number;
  code: string;
  message: string;
  body: string;
}

async function send(
  op: Operation,
  built: Built,
  actor: Actor,
): Promise<Answer> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${tokens[actor]}`,
    "idempotency-key": randomUUID(),
  };

  if (built.body !== undefined) headers["content-type"] = "application/json";

  const response = await app.inject({
    method: op.method as "GET",
    url: built.url,
    headers,
    payload: built.body === undefined ? undefined : JSON.stringify(built.body),
  });

  let code = String(response.headers["x-error-code"] ?? "");
  let message = "";

  try {
    const parsed = response.json() as { code?: string; message?: string };
    code ||= parsed.code ?? "";
    message = parsed.message ?? "";
  } catch {
    // Files and NDJSON: the status and the header are the answer.
  }

  return { status: response.statusCode, code, message, body: response.body };
}

/** Every request of a probe pair runs with a fresh limiter budget. */
async function resetLimiter(): Promise<void> {
  for (const id of actorUserIds) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        `*${id}*`,
        "COUNT",
        500,
      );
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
  }
}

let operations: Operation[] = [];

/** Every row the victim owns, hashed per table. */
async function victimSnapshot(): Promise<Record<string, string>> {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'businessId'
      AND table_name NOT LIKE 'driver_position_%'
    ORDER BY table_name
  `;

  const out: Record<string, string> = {};

  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ digest: string | null }>>(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest
       FROM "public"."${table_name}" t WHERE t."businessId" = $1`,
      B.businessId,
    );
    out[table_name] = rows[0]?.digest ?? "";
  }

  const [stops] = await prisma.$queryRaw<Array<{ digest: string | null }>>`
    SELECT md5(string_agg(s::text, '|' ORDER BY s::text)) AS digest
    FROM "route_stop" s JOIN "route" r ON r.id = s."routeId"
    WHERE r."businessId" = ${B.businessId}
  `;
  out.route_stop = stops?.digest ?? "";

  const [cards] = await prisma.$queryRaw<Array<{ digest: string | null }>>`
    SELECT md5(string_agg(c::text, '|' ORDER BY c::text)) AS digest
    FROM "kanban_card" c JOIN "kanban_column" k ON k.id = c."columnId"
    WHERE k."businessId" = ${B.businessId}
  `;
  out.kanban_card = cards?.digest ?? "";

  const [user] = await prisma.$queryRaw<Array<{ digest: string | null }>>`
    SELECT md5(string_agg(u::text, '|' ORDER BY u::text)) AS digest
    FROM "user" u WHERE u."businessId" = ${B.businessId}
  `;
  out.user = user?.digest ?? "";

  return out;
}

const findings: string[] = [];
const unknown = new Set<string>();
const unreached: string[] = [];
const trace: string[] = [];
let probes = 0;
let before: Record<string, string> = {};

function normalise(answer: Answer, ids: string[]): string {
  let message = answer.message;
  for (const id of ids) message = message.split(id).join("<id>");
  return `${answer.status} ${answer.code} ${message}`;
}

function actorsFor(op: Operation): Actor[] {
  if (op.path.startsWith("/integration/v1/")) return ["apiKey"];
  return ["admin", "driver"];
}

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();

  redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:63790");

  A = await seedSweepCarrier(prisma, { label: "A", marker: "ZZSEGREDOA" });
  B = await seedSweepCarrier(prisma, {
    label: "B",
    marker: SECRET_MARKER,
    openPause: true,
  });

  tokens.admin = await sweepToken(prisma, A.businessId, "BUSINESS_ADMIN");
  tokens.driver = await sweepToken(prisma, A.businessId, "DRIVER", A.driverId);

  const actors = await prisma.user.findMany({
    where: { businessId: A.businessId, email: { startsWith: "sweep-actor-" } },
    select: { id: true },
  });
  actorUserIds.push(...actors.map((actor) => actor.id));

  tokens.apiKey = A.apiKeyToken;
  actorUserIds.push(A.apiKeyId, A.apiKeyToken.split(".")[0]);

  const response = await app.inject({ method: "GET", url: "/docs/json" });
  const document = response.json() as {
    paths: Record<string, Record<string, Omit<Operation, "method" | "path">>>;
  };

  operations = Object.entries(document.paths).flatMap(([path, methods]) =>
    (["get", "post", "put", "patch", "delete"] as const)
      .filter((verb) => methods[verb])
      .map((verb) => ({ ...methods[verb], method: verb.toUpperCase(), path })),
  );

  // Destructive verbs last, so every other probe still finds its rows.
  operations.sort(
    (left, right) =>
      Number(left.method === "DELETE") - Number(right.method === "DELETE"),
  );

  before = await victimSnapshot();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await redis?.quit();
  await app?.close();
  await prisma.$disconnect();
});

describe("IDOR sweep over the whole OpenAPI document", () => {
  it("answers another company's id exactly like an id that does not exist", async () => {
    expect(operations.length, "o documento veio vazio").toBeGreaterThan(200);

    for (const op of operations) {
      if (isSkipped(op)) continue;

      for (const actor of actorsFor(op)) {
        for (const variant of VARIANTS[`${op.method} ${op.path}`] ?? [{}]) {
          const shape = build(op, { kind: "base" }, actor, variant);
          shape.unknownSlots.forEach((slot) =>
            unknown.add(`${op.method} ${op.path} ${slot}`),
          );

          for (const slot of shape.slots) {
            await resetLimiter();

            const victimBuilt = build(
              op,
              { kind: "probe", slot: slot.index, with: "victim" },
              actor,
              variant,
            );
            const missingBuilt = build(
              op,
              { kind: "probe", slot: slot.index, with: "missing" },
              actor,
              variant,
            );

            const victim = await send(op, victimBuilt, actor);
            const missing = await send(op, missingBuilt, actor);
            probes += 1;

            const where = `${actor} ${op.method} ${op.path} [${slot.location}]`;
            const ids = [
              victimBuilt.probeValue ?? "",
              missingBuilt.probeValue ?? "",
            ];

            if (victim.status === 429 || missing.status === 429) {
              findings.push(
                `${where}: 429 no meio da varredura (inconclusivo)`,
              );
              continue;
            }

            if (victim.status >= 500) {
              findings.push(
                `${where}: ${victim.status} ${victim.code} com o id da outra empresa`,
              );
            }

            if (victim.body.includes(SECRET_MARKER)) {
              findings.push(
                `${where}: a resposta (${victim.status}) traz dados da outra empresa`,
              );
            }

            const left = normalise(victim, ids);
            const right = normalise(missing, ids);

            trace.push(`${where}: ${left} | ${right}`);

            if (left !== right) {
              findings.push(
                `${where}: outra empresa → "${left}" ≠ inexistente → "${right}"`,
              );
            }

            if (
              victim.code === "VALIDATION_ERROR" &&
              missing.code === "VALIDATION_ERROR"
            ) {
              unreached.push(`${where}: ${victim.message}`);
            }
          }
        }
      }
    }

    // The report the next person reads when this fails.
    console.info(
      `[idor-sweep] ${probes} sondagens; ${unreached.length} pararam na validação antes do id`,
    );
    if (process.env.IDOR_SWEEP_REPORT) {
      writeFileSync(
        process.env.IDOR_SWEEP_REPORT,
        JSON.stringify(
          { findings, unknown: [...unknown], unreached, trace },
          null,
          2,
        ),
      );
    }

    expect(findings).toEqual([]);
  }, 600_000);

  it("knows every id slot the document declares", () => {
    // A slot name nobody mapped is a route this sweep silently skips.
    expect([...unknown].sort()).toEqual([]);
  });

  it("did not change a single row of the other company", async () => {
    const after = await victimSnapshot();
    const changed = Object.keys(before).filter(
      (table) => before[table] !== after[table],
    );
    expect(changed).toEqual([]);
  });
});
