import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { TENANT_MOVE_REFUSED } from "@/shared/validation/tenant-locked-field";

import { APP_BOOT_TIMEOUT_MS } from "../support/app-boot";
import {
  seedSweepCarrier,
  sweepToken,
  type CarrierIds,
} from "./support/idor-sweep-seed";

/**
 * No edit moves a record to another company (decision 16.100), checked over
 * every edit the API publishes instead of the ones somebody remembered.
 *
 * "Edit" is every authenticated PUT, PATCH and POST of the OpenAPI document
 * except the POSTs listed as creates (NOT_AN_EDIT_POSTS): a new POST is an
 * edit until somebody classifies it. For each edit, against Postgres:
 *
 *   1. a `businessId` in the body is refused with 400 VALIDATION_ERROR and
 *      the tenant-move sentence, for the company administrator and for the
 *      MASTER alike (a role gate that answers before the body is read is a
 *      refusal too, but the MASTER must reach the body and get the 400);
 *   2. every reference field of the body (branchId, vehicleId, driverId,
 *      supplierId, columnId, stop ids...) filled with a row of ANOTHER
 *      company answers exactly like an id that exists nowhere, never 2xx
 *      unless the missing id is accepted the same way (an ignored field);
 *   3. afterwards, not one row of the company re-points at a row of the
 *      other company: the indirect move ("re-home it by giving it another
 *      company's branch") left no trace.
 *
 * A new PUT, PATCH or POST is swept with no change here (a create fails the
 * businessId check until it is listed); a reference field whose name this
 * file does not know fails the coverage test, naming it.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let redis: Redis;

let A: CarrierIds;
let B: CarrierIds;

const tokens = { admin: "", master: "", driver: "" };
const actorUserIds: string[] = [];

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
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  not?: unknown;
}

interface Operation {
  method: string;
  path: string;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  security?: unknown[];
}

/**
 * The authenticated POSTs that are NOT edits: they create a row (or act on
 * the caller's own session or device). Every other authenticated POST is
 * swept as an edit, so a new POST is an edit until somebody lists it here —
 * the sweep fails closed instead of trusting a hand-kept list of edits.
 */
const NOT_AN_EDIT_POSTS = new Set([
  "POST /account-payable/create-account-payable/{businessId}",
  "POST /branch/create-branch/{businessId}",
  "POST /business/create-business",
  "POST /chat/send-message",
  "POST /chat/tickets",
  "POST /chat/tickets/{ticketId}/messages",
  "POST /delivery/create-delivery/{businessId}",
  "POST /delivery/import-xml/{businessId}",
  "POST /diagnostics/client",
  "POST /driver-pause/start/{businessId}",
  "POST /driver/create-driver/{businessId}",
  "POST /fines/create-fine/{businessId}",
  "POST /fuel-type/create-fuel-type/{businessId}",
  "POST /fuel/create-fuel/{businessId}",
  "POST /import/import-spreadsheet/{businessId}",
  "POST /integration/v1/deliveries",
  "POST /integrations/api-key/{businessId}",
  "POST /integrations/webhook-endpoint/{businessId}",
  "POST /kanban/card/create",
  "POST /kanban/column/create/{businessId}",
  "POST /notification/push-token",
  "POST /occurrence-type/create-occurrence-type/{businessId}",
  "POST /part/create-part/{businessId}",
  "POST /permission/create-permission",
  "POST /profile-access/create-profile-access",
  "POST /route/create-route/{businessId}",
  "POST /route/positions",
  "POST /service-order-part/create-service-order-part/{serviceOrderId}/business/{businessId}",
  "POST /service-order/create-service-order/{businessId}",
  "POST /shipper/create-shipper/{businessId}",
  "POST /status-change-reason/create-status-change-reason/{businessId}",
  "POST /supplier/create-supplier/{businessId}",
  "POST /uploads/avatar/presign",
  "POST /uploads/presign/{businessId}",
  "POST /user/create-master-user",
  "POST /user/create-user",
  "POST /user/logout",
  "POST /user/socket-ticket",
  "POST /vehicle-checklist/create-vehicle-checklist/{businessId}",
  "POST /vehicle-type/create-vehicle-type/{businessId}",
  "POST /vehicle/create-vehicle/{businessId}",
]);

/**
 * Edits whose body names a company on purpose (the MASTER picks it): the
 * board being reordered, the profile being configured, the conversation
 * being read. Not a move — what they touch must already belong to it, and a
 * company user naming another company is refused (asserted below).
 */
const BODY_SCOPE = new Set([
  "POST /kanban/columns/reorder",
  "POST /permission/bulk-configure-permissions",
  "POST /chat/mark-read",
  "POST /chat/mark-delivered",
]);

/**
 * The driver's own surface: probed with the driver's token on its released
 * route of the day, so a probe reaches the lookup instead of "not yours".
 */
const DRIVER_EDITS = new Set([
  "POST /route/start-route/{routeId}/business/{businessId}",
  "POST /route/on-the-way/{stopId}/route/{routeId}/business/{businessId}",
  "POST /delivery/start-route/{businessId}",
  "POST /delivery/arrival/{deliveryId}/business/{businessId}",
  "POST /delivery/proof/{deliveryId}/business/{businessId}",
  "POST /delivery/report-occurrence/{deliveryId}/business/{businessId}",
  "POST /driver-pause/end/{businessId}",
]);

/** The driver's own rows are the ones of its day on the street. */
const DRIVER_OWN: Record<string, string> = {
  deliveryId: "driverDeliveryId",
  routeId: "journeyRouteId",
  stopId: "journeyStopId",
};

/**
 * MASTER-only platform operations whose ids are not a company's rows (the
 * dead-letter replays take notification delivery ids and outbox event ids of
 * every company). Their body still refuses a businessId; there is no company
 * reference to probe.
 */
const PLATFORM_EDITS = new Set([
  "POST /health/dead-letter/replay",
  "POST /health/dead-letter/events/replay",
]);

/** Edits with no body at all: nothing in them can name a company. */
const NO_BODY = [
  "POST /ai-analysis/request/{recordType}/{recordId}",
  "POST /branch/request-branch-deletion/{branchId}/business/{businessId}",
  "POST /business/request-business-deletion/{businessId}",
  "POST /import/reverse-import/{importId}/business/{businessId}",
  "POST /integrations/webhook-delivery/{id}/business/{businessId}/resend",
  "POST /integrations/webhook-endpoint/{id}/business/{businessId}/reactivate",
  "POST /integrations/webhook-endpoint/{id}/business/{businessId}/rotate-secret",
  "PATCH /branch/toggle-branch-active/{branchId}/business/{businessId}",
  "PATCH /business/toggle-business-active/{businessId}",
  "PATCH /notification/read-all",
  "PATCH /notification/{notificationId}/read",
  "PATCH /user/revoke-access/{userId}",
  "PATCH /user/twofactor",
];

/** Which seeded row a field or path parameter name points at. */
const ENTITY_BY_NAME: Record<string, string> = {
  businessId: "businessId",
  branchId: "branchId",
  supplierId: "supplierId",
  fuelTypeId: "fuelTypeId",
  vehicleTypeId: "vehicleTypeId",
  driverId: "driverId",
  vehicleId: "vehicleId",
  partId: "partId",
  serviceOrderId: "serviceOrderId",
  serviceOrderPartId: "serviceOrderPartId",
  accountPayableId: "accountPayableId",
  fuelId: "fuelId",
  checklistId: "checklistId",
  fineId: "fineId",
  columnId: "columnId",
  cardId: "cardId",
  notificationId: "notificationId",
  shipperId: "shipperId",
  occurrenceTypeId: "occurrenceTypeId",
  occurrenceId: "occurrenceId",
  stopId: "stopId",
  start_submission_id: "pauseSubmissionId",
  reasonId: "reasonId",
  deliveryId: "deliveryId",
  deliveryIds: "looseDeliveryId",
  routeId: "routeId",
  stopIds: "stopId",
  orderedStopIds: "stopId",
  profileAccessId: "profileAccessId",
  permissionId: "permissionId",
  userId: "userId",
  masterUserId: "userId",
  responsibleUserId: "userId",
  registrationUserId: "userId",
  assignedUserId: "userId",
  assigneeId: "userId",
  expectedAssigneeId: "userId",
  auditId: "auditId",
  ticketId: "ticketId",
  threadId: "threadId",
  endpointId: "endpointId",
};

/**
 * Names that end in "id" and are not a company's row: the global traffic
 * code table, a fleet number, the platform's own quote leads, who edited a
 * location (written by the server).
 */
const NOT_A_REFERENCE = new Set([
  "trafficViolationCodeId",
  "fleet_id",
  "quoteId",
  "location_edited_by",
  // The app's idempotency keys and device id: chosen by the client, never a row.
  "client_submission_id",
  "end_submission_id",
  "device_id",
]);

interface Variant {
  omit?: string[];
  set?: Record<string, unknown>;
}

/** Bodies whose fields exclude each other: one legal shape per variant. */
const VARIANTS: Record<string, Variant[]> = {
  "PATCH /permission/update-permission/{permissionId}": [
    { set: { canRead: true } },
  ],
  "PATCH /user/update-user/{userId}": [
    { omit: ["driverId"] },
    { omit: ["profileAccessId"], set: { userType: "driver" } },
  ],
  // A transition the seeded PENDING delivery may take, so the reason is read.
  "PATCH /delivery/update-delivery-status/{deliveryId}/business/{businessId}": [
    { set: { status: "CANCELLED", note: "Cancelada na varredura" } },
  ],
};

/** The answers that mean "this reference was looked up and not found here". */
const LOOKUP_REFUSAL =
  /_NOT_FOUND$|^ACCOUNT_PAYABLE_INVALID_REFERENCE$|^TENANT_ACCESS_DENIED$/;

/**
 * Probes refused by a rule that comes before the reference lookup, each for
 * a reason that also keeps the foreign id out. Anything else that does not
 * reach the lookup fails, so the sweep cannot silently stop proving a field.
 */
const REFUSED_BEFORE_LOOKUP: Record<string, string> = {
  // Changing a link asks for the checklist's photos first; the foreign links
  // themselves are proven in vehicle-checklist-edit-http.test.ts.
  "PATCH /vehicle-checklist/update-vehicle-checklist/{checklistId}/business/{businessId} [body.vehicleId]":
    "400 PHOTOS_REQUIRED",
  "PATCH /vehicle-checklist/update-vehicle-checklist/{checklistId}/business/{businessId} [body.driverId]":
    "400 PHOTOS_REQUIRED",
  "PATCH /vehicle-checklist/update-vehicle-checklist/{checklistId}/business/{businessId} [body.branchId]":
    "400 PHOTOS_REQUIRED",
  // The order must be exactly this route's stops: a stop of another route,
  // any company's, is a mismatch.
  "PATCH /route/reorder-stops/{routeId}/business/{businessId} [body.orderedStopIds[]]":
    "409 ROUTE_REORDER_MISMATCH",
  // Only this route's stops are removed: another one is "already gone", and
  // nothing is written.
  "POST /route/remove-stops/{routeId}/business/{businessId} [body.stopIds[]]":
    "200 ",
};

const STRING_HINTS: Record<string, string> = {
  birth_date: "1990-01-01",
  cnh: "12345678900",
  rg: "123456789",
  renavam: "12345678901",
  address_number: "1",
  role: "BUSINESS_USER",
  name: "Nome Editado Completo",
  acquisition_date: "2020-01-01",
  manufacturing_year: "2020-01-01",
  model_year: "2020-01-01",
};

const NUMBER_HINTS: Record<string, number> = {
  unit_price: 10,
  amount: 100,
  total_amount: 100,
  quantity: 1,
  latitude: -23.55,
  longitude: -46.63,
};

function looksLikeReference(name: string): boolean {
  return (
    !NOT_A_REFERENCE.has(name) && (/(Id|Ids|_id)$/.test(name) || name === "id")
  );
}

function entityFor(
  op: Operation,
  location: string,
  name: string,
): string | undefined {
  // The pause type repeated in the end of a pause that never reached the API.
  if (name === "occurrence_type_id" && op.path.startsWith("/driver-pause"))
    return "pauseTypeId";
  if (name === "id") {
    if (location.includes("cards")) return "cardId";
    if (location.includes("columns")) return "columnId";
    if (op.path.startsWith("/integrations/webhook-endpoint"))
      return "endpointId";
    return undefined;
  }
  return ENTITY_BY_NAME[name];
}

function merged(schema: JsonSchema): JsonSchema {
  if (!schema.allOf?.length) return schema;

  return schema.allOf.reduce<JsonSchema>((out, part) => {
    const flat = merged(part);
    return {
      ...out,
      ...flat,
      properties: { ...out.properties, ...flat.properties },
      required: [...(out.required ?? []), ...(flat.required ?? [])],
    };
  }, {});
}

function bodySchema(op: Operation): JsonSchema | undefined {
  const schema = op.requestBody?.content?.["application/json"]?.schema;
  return schema ? merged(schema) : undefined;
}

interface Slot {
  location: string;
  name: string;
  entity: string;
}

interface Built {
  url: string;
  body: Record<string, unknown> | undefined;
  slots: Slot[];
  unknownSlots: string[];
}

type Probe = { slot: number; value: string } | null;

/**
 * The request for one edit of company A's own row: path ids are A's, the
 * body carries its required fields and every reference field (A's rows),
 * except the probed one, which gets the value under test.
 */
function build(
  op: Operation,
  probe: Probe,
  planVersion: number,
  variant: Variant = {},
): Built {
  const slots: Slot[] = [];
  const unknownSlots: string[] = [];

  const idFor = (location: string, name: string): string => {
    const entity = entityFor(op, location, name);

    if (!entity) {
      unknownSlots.push(location);
      return randomUUID();
    }

    const index = slots.length;
    slots.push({ location, name, entity });

    if (probe && probe.slot === index) return probe.value;
    // The driver works its released route of the day, not the plan.
    if (DRIVER_EDITS.has(`${op.method} ${op.path}`) && DRIVER_OWN[entity])
      return A[DRIVER_OWN[entity]];
    return A[entity];
  };

  const sample = (
    schema: JsonSchema | undefined,
    name: string,
    location: string,
  ): unknown => {
    if (!schema) return undefined;
    const flat = merged(schema);

    const variants = flat.anyOf ?? flat.oneOf;
    if (variants?.length) {
      return sample(
        variants.find((variant) => variant.type !== "null") ?? variants[0],
        name,
        location,
      );
    }

    if (flat.const !== undefined) return flat.const;
    if (flat.enum?.length)
      return flat.enum.find((value) => value !== null) ?? flat.enum[0];

    const type = Array.isArray(flat.type)
      ? flat.type.find((candidate) => candidate !== "null")
      : (flat.type ?? (flat.properties ? "object" : undefined));

    if (type === "object") {
      const out: Record<string, unknown> = {};

      for (const [key, child] of Object.entries(flat.properties ?? {})) {
        // The tenant-locked field: never part of a legitimate edit.
        if (
          location === "body" &&
          key === "businessId" &&
          child.not !== undefined
        )
          continue;
        if (location === "body" && variant.omit?.includes(key)) continue;
        if (location === "body" && variant.set && key in variant.set) {
          out[key] = variant.set[key];
          continue;
        }

        const required = flat.required?.includes(key) ?? false;
        if (
          !required &&
          !looksLikeReference(key) &&
          key !== "expectedPlanVersion"
        )
          continue;

        out[key] = sample(child, key, `${location}.${key}`);
      }

      return out;
    }

    if (type === "array") {
      const itemsHaveId = Boolean(flat.items?.properties?.id);
      if (
        !looksLikeReference(name) &&
        !itemsHaveId &&
        !(flat.minItems && flat.minItems > 0)
      )
        return [];
      return [sample(flat.items, name, `${location}[]`)];
    }

    if (type === "string") {
      if (looksLikeReference(name)) return idFor(location, name);

      if (flat.format === "uuid") return randomUUID();
      if (flat.format === "date-time") return new Date().toISOString();
      if (flat.format === "date") return "2026-10-07";
      if (flat.format === "email")
        return `move-${randomUUID().slice(0, 8)}@exemplo.com.br`;
      if (flat.format === "uri" || flat.format === "url")
        return "https://example.com/move";
      if (STRING_HINTS[name] !== undefined) return STRING_HINTS[name];

      const lower = name.toLowerCase();
      let value = "Edição de teste";
      if (/date|_at$|day/.test(lower)) value = "2026-10-07";
      else if (lower.includes("cnpj")) value = "11222333000181";
      else if (lower.includes("cpf")) value = "52998224725";
      else if (lower.includes("plate")) value = "ABC1D23";
      else if (lower.includes("cep")) value = "01001000";
      else if (lower === "uf") value = "SP";
      else if (/phone|telephone/.test(lower)) value = "11999999999";
      else if (lower.includes("color")) value = "#000000";

      if (flat.maxLength !== undefined && value.length > flat.maxLength)
        value = value.slice(0, flat.maxLength);
      if (flat.minLength !== undefined && value.length < flat.minLength)
        value = value.padEnd(flat.minLength, "x");
      return value;
    }

    if (type === "integer" || type === "number") {
      if (name === "expectedPlanVersion") return planVersion;
      if (NUMBER_HINTS[name] !== undefined) return NUMBER_HINTS[name];
      let value = typeof flat.minimum === "number" ? flat.minimum : 1;
      if (typeof flat.maximum === "number" && value > flat.maximum)
        value = flat.maximum;
      return value;
    }

    if (type === "boolean") return name === "canRead";

    return undefined;
  };

  // Path first, then body: the slot numbering order.
  const url = op.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    if (name === "id") return idFor(`path.${name}`, name);
    if (name === "module") return "FLEET";
    if (name === "quoteId") return randomUUID();
    return idFor(`path.${name}`, name);
  });

  const schema = bodySchema(op);
  const body = schema
    ? (sample(schema, "", "body") as Record<string, unknown>)
    : undefined;

  return { url, body, slots, unknownSlots };
}

interface Answer {
  status: number;
  code: string;
  message: string;
  issues: string[];
}

async function send(
  op: Operation,
  url: string,
  body: Record<string, unknown> | undefined,
  token: string,
): Promise<Answer> {
  const response = await app.inject({
    method: op.method as "PATCH",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });

  let parsed: {
    code?: string;
    message?: string;
    issues?: string[];
    details?: string;
  } = {};
  try {
    parsed = response.json();
  } catch {
    // Not JSON: the status is the answer.
  }

  return {
    status: response.statusCode,
    code: String(parsed.code ?? response.headers["x-error-code"] ?? ""),
    message: parsed.message ?? "",
    // The multipart-era controllers (checklist) put the zod text in `details`.
    issues: [
      ...(Array.isArray(parsed.issues) ? parsed.issues : []),
      ...(parsed.details ? [parsed.details] : []),
    ],
  };
}

/** Each request of a probe pair runs with a fresh limiter budget. */
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

async function planVersionOf(routeId: string): Promise<number> {
  const route = await prisma.route.findUnique({
    where: { id: routeId },
    select: { plan_version: true },
  });
  return route?.plan_version ?? 0;
}

async function masterToken(): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Master da varredura",
      email: `move-master-${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "MASTER",
      businessId: null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  actorUserIds.push(id);

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    {
      subject: id,
      expiresIn: "30m",
    },
  );
}

/** Tables whose rows carry a company, plus the two that hang off a parent. */
async function companyRows(
  businessId: string,
): Promise<Array<{ table: string; row: Record<string, unknown> }>> {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'businessId'
      AND table_name NOT LIKE 'driver_position_%'
    ORDER BY table_name
  `;

  const out: Array<{ table: string; row: Record<string, unknown> }> = [];

  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ row: Record<string, unknown> }>
    >(
      `SELECT to_jsonb(t) AS row FROM "public"."${table_name}" t WHERE t."businessId" = $1`,
      businessId,
    );
    rows.forEach(({ row }) => out.push({ table: table_name, row }));
  }

  const stops = await prisma.$queryRaw<Array<{ row: Record<string, unknown> }>>`
    SELECT to_jsonb(s) AS row FROM "route_stop" s JOIN "route" r ON r.id = s."routeId"
    WHERE r."businessId" = ${businessId}
  `;
  stops.forEach(({ row }) => out.push({ table: "route_stop", row }));

  const cards = await prisma.$queryRaw<Array<{ row: Record<string, unknown> }>>`
    SELECT to_jsonb(c) AS row FROM "kanban_card" c JOIN "kanban_column" k ON k.id = c."columnId"
    WHERE k."businessId" = ${businessId}
  `;
  cards.forEach(({ row }) => out.push({ table: "kanban_card", row }));

  return out;
}

let operations: Operation[] = [];
let edits: Operation[] = [];

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();

  redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:63790");

  A = await seedSweepCarrier(prisma, { label: "A", marker: "ZZMUDAA" });
  B = await seedSweepCarrier(prisma, { label: "B", marker: "ZZMUDAB" });

  tokens.admin = await sweepToken(prisma, A.businessId, "BUSINESS_ADMIN");
  tokens.master = await masterToken();
  tokens.driver = await sweepToken(prisma, A.businessId, "DRIVER", A.driverId);

  const actors = await prisma.user.findMany({
    where: { businessId: A.businessId, email: { startsWith: "sweep-actor-" } },
    select: { id: true },
  });
  actorUserIds.push(...actors.map((actor) => actor.id));

  const response = await app.inject({ method: "GET", url: "/docs/json" });
  const document = response.json() as {
    paths: Record<string, Record<string, Omit<Operation, "method" | "path">>>;
  };

  operations = Object.entries(document.paths).flatMap(([path, methods]) =>
    (["post", "put", "patch"] as const)
      .filter((verb) => methods[verb])
      .map((verb) => ({ ...methods[verb], method: verb.toUpperCase(), path })),
  );

  edits = operations.filter(
    (op) =>
      op.security?.length && !NOT_AN_EDIT_POSTS.has(`${op.method} ${op.path}`),
  );
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await redis?.quit();
  await app?.close();
  await prisma.$disconnect();
});

const id = (op: Operation) => `${op.method} ${op.path}`;

describe("the edits the sweep walks", () => {
  it("are every authenticated PUT, PATCH and POST of the document except the listed creates", () => {
    expect(edits.length, "nenhuma edição no documento").toBeGreaterThan(70);

    const published = new Set(operations.map(id));
    const listed = [
      ...NOT_AN_EDIT_POSTS,
      ...BODY_SCOPE,
      ...DRIVER_EDITS,
      ...PLATFORM_EDITS,
    ];
    for (const post of listed)
      expect(published.has(post), `${post} sumiu do documento`).toBe(true);

    // A POST that names an existing record in its path changes that record:
    // only a create under a parent (a part of an order, a message of a
    // ticket) may be listed as a create.
    const createsUnderRecord = [...NOT_AN_EDIT_POSTS].filter((post) =>
      [...post.matchAll(/\{(\w+)\}/g)].some(
        ([, name]) => name !== "businessId",
      ),
    );
    expect(createsUnderRecord.sort()).toEqual([
      "POST /chat/tickets/{ticketId}/messages",
      "POST /service-order-part/create-service-order-part/{serviceOrderId}/business/{businessId}",
    ]);

    // The row-changing POSTs the hand-kept list of the previous round missed.
    for (const post of [
      "POST /route/add-stops/{routeId}/business/{businessId}",
      "POST /route/start-route/{routeId}/business/{businessId}",
      "POST /route/on-the-way/{stopId}/route/{routeId}/business/{businessId}",
      "POST /delivery/arrival/{deliveryId}/business/{businessId}",
      "POST /delivery/proof/{deliveryId}/business/{businessId}",
      "POST /delivery/report-occurrence/{deliveryId}/business/{businessId}",
      "POST /delivery/occurrence-authorization/{occurrenceId}/business/{businessId}",
      "POST /chat/tickets/{ticketId}/close",
      "POST /chat/tickets/{ticketId}/reopen",
      "POST /chat/tickets/{ticketId}/read",
      "POST /driver-pause/end/{businessId}",
    ]) {
      expect(edits.map(id), post).toContain(post);
    }

    const bodiless = edits
      .filter((op) => !op.requestBody)
      .map(id)
      .sort();
    expect(bodiless).toEqual([...NO_BODY].sort());
  });
});

describe("a businessId in an edit body", () => {
  it("is refused with 400 VALIDATION_ERROR for the MASTER and the company administrator, on every edit", async () => {
    const findings: string[] = [];

    for (const op of edits) {
      if (!op.requestBody || BODY_SCOPE.has(id(op))) continue;

      const { url } = build(op, null, await planVersionOf(A.routeId));

      for (const actor of ["master", "admin"] as const) {
        await resetLimiter();
        const answer = await send(
          op,
          url,
          { businessId: B.businessId },
          tokens[actor],
        );

        const refusedAsMove =
          answer.status === 400 &&
          answer.code === "VALIDATION_ERROR" &&
          [answer.message, ...answer.issues]
            .join(" ")
            .includes(TENANT_MOVE_REFUSED);

        // A role gate that answers before the body is read (MASTER-only
        // routes) refuses the company administrator just as well.
        const refusedBeforeBody = actor === "admin" && answer.status === 403;

        if (!refusedAsMove && !refusedBeforeBody) {
          findings.push(
            `${actor} ${id(op)}: ${answer.status} ${answer.code} ${answer.message}`,
          );
        }
      }
    }

    expect(findings).toEqual([]);
  }, 300_000);

  it("names the board on the column reorder, and another company's board is refused", async () => {
    await resetLimiter();
    const answer = await send(
      { method: "POST", path: "/kanban/columns/reorder" },
      "/kanban/columns/reorder",
      { businessId: B.businessId, columns: [{ id: B.columnId, position: 0 }] },
      tokens.admin,
    );

    expect(answer.status).toBe(403);
    const column = await prisma.kanbanColumn.findUniqueOrThrow({
      where: { id: B.columnId },
    });
    expect(column.businessId).toBe(B.businessId);
  });

  it("names the company on the other body-scoped edits, and another company is refused", async () => {
    const before = await prisma.permission.findMany({
      where: { profileAccessId: B.profileAccessId },
      orderBy: { id: "asc" },
    });

    const attempts: Array<[string, Record<string, unknown>]> = [
      [
        "/permission/bulk-configure-permissions",
        {
          businessId: B.businessId,
          profileAccessId: B.profileAccessId,
          permissions: [
            { permissionKey: "vehicle_manage", canRead: true, canWrite: true },
          ],
        },
      ],
      ["/chat/mark-read", { businessId: B.businessId, threadId: B.threadId }],
      [
        "/chat/mark-delivered",
        { businessId: B.businessId, threadId: B.threadId },
      ],
    ];

    const answers: Record<string, number> = {};
    for (const [url, body] of attempts) {
      await resetLimiter();
      answers[url] = (
        await send({ method: "POST", path: url }, url, body, tokens.admin)
      ).status;
    }

    for (const [url, status] of Object.entries(answers)) {
      expect([403, 404], `${url} respondeu ${status}`).toContain(status);
    }

    const after = await prisma.permission.findMany({
      where: { profileAccessId: B.profileAccessId },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });
});

describe("another company's id in a reference field of an edit", () => {
  const findings: string[] = [];
  const unknown = new Set<string>();
  const unreached: string[] = [];
  const beforeLookup: Record<string, string> = {};
  let probes = 0;
  let masterProbes = 0;
  let driverProbes = 0;

  it("answers exactly like an id that exists nowhere", async () => {
    for (const op of edits) {
      if (!op.requestBody || PLATFORM_EDITS.has(id(op))) continue;
      // The MASTER is the one actor the tenant guard lets into any company:
      // a use case that skipped the lookup for it would re-home a record.
      const actors = DRIVER_EDITS.has(id(op))
        ? (["driver"] as const)
        : (["admin", "master"] as const);

      for (const actor of actors) {
        const token = tokens[actor];

        for (const variant of VARIANTS[id(op)] ?? [{}]) {
          const shape = build(
            op,
            null,
            await planVersionOf(A.routeId),
            variant,
          );
          shape.unknownSlots.forEach((slot) =>
            unknown.add(`${id(op)} ${slot}`),
          );

          for (let index = 0; index < shape.slots.length; index += 1) {
            const slot = shape.slots[index];
            // Path ids are the record being edited: the IDOR sweep owns them.
            if (!slot.location.startsWith("body")) continue;

            const missingValue = randomUUID();
            const version = await planVersionOf(A.routeId);

            await resetLimiter();
            const victimBuilt = build(
              op,
              { slot: index, value: B[slot.entity] },
              version,
              variant,
            );
            const victim = await send(
              op,
              victimBuilt.url,
              victimBuilt.body,
              token,
            );

            await resetLimiter();
            const missingBuilt = build(
              op,
              { slot: index, value: missingValue },
              await planVersionOf(A.routeId),
              variant,
            );
            const missing = await send(
              op,
              missingBuilt.url,
              missingBuilt.body,
              token,
            );
            probes += 1;

            const where = `${actor === "master" ? "master " : ""}${id(op)} [${slot.location}]`;
            const normalise = (answer: Answer, value: string) =>
              `${answer.status} ${answer.code} ${answer.message.split(value).join("<id>")}`;

            const left = normalise(victim, B[slot.entity]);
            const right = normalise(missing, missingValue);

            if (process.env.COMPANY_MOVE_TRACE)
              console.info(`${where}: ${left} | ${right}`);
            if (victim.status >= 500)
              findings.push(
                `${where}: ${victim.status} com o id da outra empresa`,
              );
            if (actor === "master") {
              // The MASTER sees every company, so hiding that the id exists
              // elsewhere protects nothing (decision 16.813): its answer may name
              // the mismatch (USER_NOT_IN_BUSINESS, KANBAN_CARD_CROSS_BOARD_MOVE)
              // or come from the use case instead of the branch gate. It must
              // still be refused whenever a missing id is (an idempotent no-op
              // such as remove-stops answers 200 to both), and the leak check
              // below proves nothing moved.
              if (victim.status < 400 && missing.status >= 400) {
                findings.push(
                  `${where}: aceitou o id da outra empresa (${victim.status})`,
                );
              }
            } else {
              if (left !== right)
                findings.push(
                  `${where}: outra empresa → "${left}" ≠ inexistente → "${right}"`,
                );
              if (victim.status < 300 && missing.status >= 300) {
                findings.push(
                  `${where}: aceitou o id da outra empresa (${victim.status})`,
                );
              }
            }
            if (victim.code === "VALIDATION_ERROR")
              unreached.push(
                `${where}: ${victim.message} ${victim.issues.join("; ")}`,
              );
            // The pinned map of rules that answer before the lookup is the admin's.
            if (actor !== "master" && !LOOKUP_REFUSAL.test(victim.code)) {
              beforeLookup[where] = `${victim.status} ${victim.code}`;
            }
            if (actor === "master") masterProbes += 1;
            if (actor === "driver") driverProbes += 1;
          }
        }
      }
    }

    console.info(
      `[company-move-sweep] ${probes} sondagens (${masterProbes} como MASTER); ${unreached.length} pararam na validação`,
    );
    if (unreached.length) console.info(unreached.join("\n"));

    expect(findings).toEqual([]);
  }, 600_000);

  it("probes the MASTER too, on every non-driver edit", () => {
    expect(masterProbes).toBeGreaterThan(0);
    expect(masterProbes).toBe(probes - masterProbes - driverProbes);
  });

  it("knows every reference field the edits declare", () => {
    expect([...unknown].sort()).toEqual([]);
  });

  it("reaches the reference lookup on every probe instead of stopping at validation", () => {
    expect(unreached).toEqual([]);
  });

  it("is looked up and refused on every probe, or stopped by a rule that keeps it out", () => {
    expect(beforeLookup).toEqual(REFUSED_BEFORE_LOOKUP);
  });

  it("left no row of the company pointing at a row of the other company", async () => {
    const theirs = new Set(
      (await companyRows(B.businessId))
        .map(({ row }) => row.id)
        .filter((value): value is string => typeof value === "string"),
    );
    theirs.add(B.businessId);

    const leaks: string[] = [];

    for (const { table, row } of await companyRows(A.businessId)) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value === "string" && theirs.has(value))
          leaks.push(`${table}.${column} = ${value}`);
      }
    }

    expect(leaks).toEqual([]);
  });
});
