import "@/shared";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import auth from "@/config/auth";

import type { UploadService } from "@/shared/services/upload-service";

import { fakeJpeg } from "./support/fleet-driver-seed";

/**
 * The occurrence form (decision 6.2) and the tower's authorization (6.3)
 * over real HTTP and Postgres: the report that waits without effect, the
 * queue, one decision whoever clicks (two operators at once), the proof that
 * supersedes, the driver's day, and the walls — another company, a driver
 * token, a read-only profile.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let uploads: UploadService;

const CARRIER = "018fe900-0000-7000-8000-00000000000a";
const OTHER = "018fe900-0000-7000-8000-00000000000b";
// A company that has not contracted Entregas.
const FLEET_ONLY = "018fe900-0000-7000-8000-00000000000c";

const SHIPPER = "018fe900-0000-7000-8000-0000000000f1";
const OTHER_SHIPPER = "018fe900-0000-7000-8000-0000000000f2";

const DRIVER = "018fe900-0000-7000-8000-0000000000d1";
// The driver a delivery is handed over to (review r2).
const OTHER_DRIVER = "018fe900-0000-7000-8000-0000000000d2";

const TOWER_TYPE = "018fe900-0000-7000-8000-0000000000e1";
const TOWER_INFO_TYPE = "018fe900-0000-7000-8000-0000000000e2";
const EDITED_TYPE = "018fe900-0000-7000-8000-0000000000e3";
const SYSTEM_TYPE = "018fe900-0000-7000-8000-0000000000e4";
const FOREIGN_TYPE = "018fe900-0000-7000-8000-0000000000e5";

const FOREIGN_DELIVERY = "018fe900-0000-7000-8000-0000000000c9";

/** The panel's status change needs a reason from the catalogue. */
let statusReasonId = "";

const TOWER_FORM = [
  { key: "quem_atendeu", label: "Quem atendeu", type: "text", required: true, max_length: 60, multiline: false },
  { key: "ligou_cliente", label: "Ligou para o cliente", type: "boolean", required: true },
  { key: "motivo", label: "Motivo", type: "select", required: true, options: ["Ausente", "Recusa"] },
];

const VALID_ANSWERS = { quem_atendeu: "Porteiro", ligou_cliente: true, motivo: "Ausente" };

const users: Record<
  | "admin"
  | "operator"
  | "readOnly"
  | "driver"
  | "otherDriver"
  | "otherAdmin"
  | "fleetOnlyAdmin"
  | "clerk",
  { id: string; token: string }
> = {} as never;

const storedKeys: string[] = [];

let cnpjSeq = 0;

async function seedBusiness(id: string, deliveries = true): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Torres",
      address_number: "1",
      cnpj: String(41222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  if (!deliveries) return;

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedProfile(
  businessId: string,
  grants: Array<{ key: string; write: boolean }>,
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId,
      permissions: {
        create: grants.map(({ key, write }) => ({
          permissionKey: key,
          action: key,
          canRead: true,
          canWrite: write,
          businessId,
        })),
      },
    },
  });

  return profile.id;
}

async function seedUser(
  name: string,
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string,
  extra: { profileAccessId?: string; driverId?: string } = {},
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId: extra.profileAccessId ?? null,
      driverId: extra.driverId ?? null,
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

  return {
    id,
    token: sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
      subject: id,
      expiresIn: "15m",
    }),
  };
}

async function inTransit(recipient: string): Promise<string> {
  const delivery = await prisma.delivery.create({
    data: {
      recipient_name: recipient,
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
      businessId: CARRIER,
      shipperId: SHIPPER,
      driverId: DRIVER,
      status: "IN_TRANSIT",
    },
  });

  return delivery.id;
}

interface Answer {
  status: number;
  body: Record<string, any>;
}

async function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload && { payload }),
  });

  return { status: response.statusCode, body: response.json() };
}

function report(
  deliveryId: string,
  body: Record<string, unknown>,
  token = users.driver.token,
  businessId = CARRIER,
): Promise<Answer> {
  return call(
    "POST",
    `/delivery/report-occurrence/${deliveryId}/business/${businessId}`,
    token,
    body,
  );
}

function decide(
  occurrenceId: string,
  body: Record<string, unknown>,
  token: string,
  businessId = CARRIER,
): Promise<Answer> {
  return call(
    "POST",
    `/delivery/occurrence-authorization/${occurrenceId}/business/${businessId}`,
    token,
    body,
  );
}

async function pendingOn(recipient: string): Promise<{ deliveryId: string; occurrenceId: string }> {
  const deliveryId = await inTransit(recipient);

  const answer = await report(deliveryId, {
    occurrenceTypeId: TOWER_TYPE,
    form_answers: VALID_ANSWERS,
    form_version: 1,
  });

  expect(answer.status).toBe(201);
  expect(answer.body.data.authorization_status).toBe("PENDING");

  return { deliveryId, occurrenceId: answer.body.data.id };
}

const outboxOf = (aggregateId: string, topic: string) =>
  prisma.domainOutboxEvent.findMany({ where: { aggregateId, topic } });

/** What the shipper's ERP was sent about one delivery, by topic. */
async function webhooksAbout(deliveryId: string, topic: string) {
  const rows = await prisma.webhookDelivery.findMany({
    where: { businessId: CARRIER, topic },
  });

  return rows
    .map((row) => (row.payload as { data: Record<string, unknown> }).data)
    .filter((data) => data.delivery_id === deliveryId);
}

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
      { id: OTHER_SHIPPER, name: "Embarcador Alheio", businessId: OTHER },
    ],
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "João Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-auth-1",
      cpf: "cpf-auth-1",
      rg: "rg-auth-1",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  await prisma.driver.create({
    data: {
      id: OTHER_DRIVER,
      name: "Beatriz Motorista",
      birth_date: new Date("1991-02-02"),
      cnh: "cnh-auth-2",
      cpf: "cpf-auth-2",
      rg: "rg-auth-2",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "2",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  users.admin = await seedUser("Ana Administradora", "BUSINESS_ADMIN", CARRIER);
  users.operator = await seedUser("Otto Torre", "BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, [
      { key: "delivery_manage", write: true },
      { key: "occurrence_manage", write: true },
    ]),
  });
  users.readOnly = await seedUser("Rita Leitura", "BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, [
      { key: "delivery_manage", write: false },
      { key: "occurrence_manage", write: false },
    ]),
  });
  users.driver = await seedUser("João Motorista", "BUSINESS_USER", CARRIER, {
    driverId: DRIVER,
  });
  users.otherDriver = await seedUser("Beatriz Motorista", "BUSINESS_USER", CARRIER, {
    driverId: OTHER_DRIVER,
  });
  users.otherAdmin = await seedUser("Beto Outra", "BUSINESS_ADMIN", OTHER);
  // Reports occurrences, only reads deliveries: the queue refuses its decision.
  users.clerk = await seedUser("Clara Escritório", "BUSINESS_USER", CARRIER, {
    profileAccessId: await seedProfile(CARRIER, [
      { key: "delivery_manage", write: false },
      { key: "occurrence_manage", write: true },
    ]),
  });

  statusReasonId = (
    await prisma.statusChangeReason.create({
      data: { name: "Pedido do cliente", businessId: CARRIER },
    })
  ).id;

  await seedBusiness(FLEET_ONLY, false);
  users.fleetOnlyAdmin = await seedUser("Frida Frota", "BUSINESS_ADMIN", FLEET_ONLY);

  await prisma.occurrenceType.createMany({
    data: [
      {
        id: TOWER_TYPE,
        name: "Cliente ausente (torre)",
        blocks_delivery: true,
        requires_authorization: true,
        form_fields: TOWER_FORM,
        businessId: CARRIER,
      },
      {
        id: TOWER_INFO_TYPE,
        name: "Deixar com vizinho",
        blocks_delivery: false,
        requires_authorization: true,
        businessId: CARRIER,
      },
      {
        // The form moved to version 2 with a new required question.
        id: EDITED_TYPE,
        name: "Avaria",
        blocks_delivery: false,
        form_fields: [
          { key: "volumes", label: "Volumes", type: "number", required: true, integer: true },
        ],
        form_version: 2,
        businessId: CARRIER,
      },
      {
        id: SYSTEM_TYPE,
        name: "Comprovante rejeitado",
        is_system: true,
        businessId: CARRIER,
      },
      { id: FOREIGN_TYPE, name: "Alheio", businessId: OTHER },
    ],
  });

  await prisma.delivery.create({
    data: {
      id: FOREIGN_DELIVERY,
      recipient_name: "Cliente alheio",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: OTHER,
      shipperId: OTHER_SHIPPER,
      status: "IN_TRANSIT",
    },
  });

  // A subscribed ERP: what it is (not) sent is the webhook half of 6.3.
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP do embarcador",
      url: "https://erp.example.invalid/hook",
      secret: "segredo-de-teste-com-tamanho-suficiente",
      topics: ["occurrence.*", "delivery.*"],
      businessId: CARRIER,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the driver's report of a type with a form", () => {
  it("refuses answers that do not fit the form, naming the field, and stores nothing", async () => {
    const deliveryId = await inTransit("Forma inválida");

    const answer = await report(deliveryId, {
      occurrenceTypeId: TOWER_TYPE,
      form_answers: { quem_atendeu: "Porteiro", motivo: "Outro" },
      form_version: 1,
    });

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      code: "OCCURRENCE_FORM_INVALID",
      field_errors: {
        ligou_cliente: 'Responda "Ligou para o cliente".',
        motivo: 'Escolha uma das opções de "Motivo".',
      },
    });

    expect(await prisma.deliveryOccurrence.count({ where: { deliveryId } })).toBe(0);
  });

  it("answers a stale form with 409 and the current form", async () => {
    const deliveryId = await inTransit("Formulário antigo");

    const answer = await report(deliveryId, {
      occurrenceTypeId: EDITED_TYPE,
      form_answers: {},
      form_version: 1,
    });

    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({
      code: "OCCURRENCE_FORM_OUTDATED",
      form_version: 2,
      form_fields: [{ key: "volumes", label: "Volumes", type: "number", required: true }],
      field_errors: { volumes: 'Preencha o campo "Volumes".' },
    });
  });
});

describe("a report that waits for the tower", () => {
  let deliveryId = "";
  let occurrenceId = "";
  const submission = randomUUID();

  it("is PENDING and applies nothing", async () => {
    deliveryId = await inTransit("Aguardando torre");

    const answer = await report(deliveryId, {
      occurrenceTypeId: TOWER_TYPE,
      form_answers: VALID_ANSWERS,
      form_version: 1,
      client_submission_id: submission,
    });

    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      message: "Ocorrência registrada. Aguardando autorização da torre.",
      data: { authorization_status: "PENDING", replayed: false },
    });

    occurrenceId = answer.body.data.id;

    const occurrence = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
    });

    expect(occurrence).toMatchObject({
      authorization_status: "PENDING",
      form_answers: VALID_ANSWERS,
      form_version: 1,
      authorizedById: null,
      escalated_at: null,
    });

    // No effect: still on the street, no insucesso, no webhook, no customer.
    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });

    expect(delivery.status).toBe("IN_TRANSIT");
    expect(await outboxOf(deliveryId, "delivery-occurrence.reported")).toHaveLength(0);
    expect(await outboxOf(deliveryId, "delivery.failed")).toHaveLength(0);
    expect(await webhooksAbout(deliveryId, "occurrence.reported")).toHaveLength(0);
    expect(await webhooksAbout(deliveryId, "delivery.failed")).toHaveLength(0);

    const [request] = await outboxOf(deliveryId, "delivery-occurrence.authorization_requested");

    expect(request.eventKey).toBe(`delivery-occurrence.authorization_requested:${occurrenceId}`);
    expect(request.payload).toMatchObject({
      occurrenceId,
      reporterName: "João Motorista",
      answers: [
        { label: "Quem atendeu", value: "Porteiro" },
        { label: "Ligou para o cliente", value: "Sim" },
        { label: "Motivo", value: "Ausente" },
      ],
    });

    // On the trail and the tower's feed (TWR-6), linked to the occurrence.
    const events = await prisma.deliveryEvent.findMany({ where: { deliveryId } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "OCCURRENCE",
      occurrenceId,
      actor: "DRIVER_APP",
      businessId: CARRIER,
    });
  });

  it("a resend of the same submission is the same occurrence", async () => {
    const answer = await report(deliveryId, {
      occurrenceTypeId: TOWER_TYPE,
      form_answers: VALID_ANSWERS,
      form_version: 1,
      client_submission_id: submission,
    });

    expect(answer.status).toBe(201);
    expect(answer.body.data).toEqual({
      id: occurrenceId,
      authorization_status: "PENDING",
      replayed: true,
      // Decision 14.3: the category and where the delivery stands.
      category: "NOT_DELIVERED",
      delivery_status: "IN_TRANSIT",
      // Decision 14.5: the resend names the ticket the first report opened.
      ticket: { id: expect.any(String), number: expect.any(Number) },
    });
    expect(await prisma.deliveryOccurrence.count({ where: { deliveryId } })).toBe(1);
  });

  it("shows once in the delivery's history (no double line from its event)", async () => {
    const answer = await call(
      "GET",
      `/delivery/get-delivery/${deliveryId}/business/${CARRIER}`,
      users.operator.token,
    );

    expect(answer.status).toBe(200);

    const timeline = answer.body.data.timeline as Array<{ id: string; kind: string }>;

    expect(timeline.filter((entry) => entry.kind === "OCCURRENCE")).toEqual([
      expect.objectContaining({ id: occurrenceId }),
    ]);
    expect(answer.body.data.occurrences[0]).toMatchObject({
      authorization_status: "PENDING",
      form_answers: VALID_ANSWERS,
      authorizedBy: null,
      occurrenceType: { requires_authorization: true, form_version: 1 },
    });
  });

  it("the driver's day carries the request and the forms", async () => {
    const answer = await call("GET", `/delivery/my-deliveries/${CARRIER}`, users.driver.token);

    expect(answer.status).toBe(200);

    const row = (answer.body.data as Array<Record<string, any>>).find(
      (entry) => entry.id === deliveryId,
    );

    expect(row?.authorization_request).toMatchObject({
      occurrenceId,
      occurrenceTypeName: "Cliente ausente (torre)",
      status: "PENDING",
      note: null,
    });

    const types = answer.body.occurrence_types as Array<Record<string, any>>;
    const tower = types.find((type) => type.id === TOWER_TYPE);

    expect(tower).toMatchObject({
      requires_authorization: true,
      form_version: 1,
      form_fields: [
        { key: "quem_atendeu", type: "text", required: true },
        { key: "ligou_cliente", type: "boolean", required: true },
        { key: "motivo", type: "select", options: ["Ausente", "Recusa"] },
      ],
    });
    expect(types.some((type) => type.id === SYSTEM_TYPE)).toBe(false);
  });

  it("is in the tower's queue for those who read deliveries, and only theirs", async () => {
    const operator = await call("GET", "/delivery/occurrence-authorizations", users.operator.token);

    expect(operator.status).toBe(200);
    expect(operator.body.total).toBeGreaterThanOrEqual(1);

    const row = (operator.body.data as Array<Record<string, any>>).find(
      (entry) => entry.id === occurrenceId,
    );

    expect(row).toMatchObject({
      deliveryId,
      reportedBy: { name: "João Motorista" },
      delivery: { recipient_name: "Aguardando torre", status: "IN_TRANSIT" },
      answers: [
        { label: "Quem atendeu", value: "Porteiro" },
        { label: "Ligou para o cliente", value: "Sim" },
        { label: "Motivo", value: "Ausente" },
      ],
    });

    const readOnly = await call("GET", "/delivery/occurrence-authorizations", users.readOnly.token);

    expect(readOnly.status).toBe(200);

    const driver = await call("GET", "/delivery/occurrence-authorizations", users.driver.token);

    expect(driver).toMatchObject({ status: 403, body: { code: "PERMISSION_DENIED" } });

    const other = await call("GET", "/delivery/occurrence-authorizations", users.otherAdmin.token);

    expect(other.status).toBe(200);
    expect(other.body.total).toBe(0);

    // Entregas not contracted: the module answers before anything else.
    const fleetOnly = await call(
      "GET",
      "/delivery/occurrence-authorizations",
      users.fleetOnlyAdmin.token,
    );

    expect(fleetOnly).toMatchObject({ status: 403, body: { code: "MODULE_NOT_ENABLED" } });

    const peeking = await call(
      "GET",
      `/delivery/occurrence-authorizations?businessId=${CARRIER}`,
      users.otherAdmin.token,
    );

    expect(peeking.status).toBe(403);
  });

  it("is decided only by the company's dispatchers", async () => {
    const driver = await decide(occurrenceId, { decision: "APPROVED" }, users.driver.token);
    const readOnly = await decide(occurrenceId, { decision: "APPROVED" }, users.readOnly.token);

    expect(driver).toMatchObject({ status: 403, body: { code: "PERMISSION_DENIED" } });
    expect(readOnly).toMatchObject({ status: 403, body: { code: "PERMISSION_DENIED" } });

    // Another company: under its own id the occurrence does not exist; under
    // the carrier's id the tenant guard refuses first.
    const foreignOwn = await decide(
      occurrenceId,
      { decision: "APPROVED" },
      users.otherAdmin.token,
      OTHER,
    );
    const foreignPeek = await decide(occurrenceId, { decision: "APPROVED" }, users.otherAdmin.token);

    expect(foreignOwn).toMatchObject({ status: 404, body: { code: "OCCURRENCE_NOT_FOUND" } });
    expect(foreignPeek.status).toBe(403);

    const noReason = await decide(occurrenceId, { decision: "DENIED" }, users.operator.token);
    const badDecision = await decide(occurrenceId, { decision: "MAYBE" }, users.operator.token);

    expect(noReason).toMatchObject({ status: 400, body: { code: "AUTHORIZATION_NOTE_REQUIRED" } });
    expect(badDecision).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });

    const occurrence = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
    });

    expect(occurrence.authorization_status).toBe("PENDING");
  });

  it("two operators at once make ONE decision; the other hears who decided", async () => {
    const answers = await Promise.all([
      decide(occurrenceId, { decision: "APPROVED", note: "Pode voltar com a carga." }, users.operator.token),
      decide(occurrenceId, { decision: "APPROVED" }, users.admin.token),
    ]);

    const winner = answers.find((answer) => answer.status === 200)!;
    const loser = answers.find((answer) => answer.status === 409)!;

    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(loser.body).toMatchObject({
      code: "OCCURRENCE_ALREADY_DECIDED",
      decision: {
        status: "APPROVED",
        authorizedBy: winner.body.data.authorizedBy,
      },
    });
    expect(winner.body.data).toMatchObject({
      authorization_status: "APPROVED",
      deliveryStatus: "FAILED",
      replayed: false,
    });

    // The effect, once: FAILED, one STATUS_CHANGE at the approval, one
    // insucesso notice, one answer to the driver.
    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });

    expect(delivery.status).toBe("FAILED");

    const flips = await prisma.deliveryEvent.findMany({
      where: { deliveryId, type: "STATUS_CHANGE" },
    });

    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({
      status_from: "IN_TRANSIT",
      status_to: "FAILED",
      occurrenceId,
      reportedById: winner.body.data.authorizedBy.id,
    });

    expect(await outboxOf(deliveryId, "delivery-occurrence.reported")).toHaveLength(1);

    // The shipper hears it now, once, with the status after the approval.
    const reported = await webhooksAbout(deliveryId, "occurrence.reported");

    expect(reported).toHaveLength(1);
    expect(reported[0].status).toBe("FAILED");
    expect(await webhooksAbout(deliveryId, "delivery.failed")).toHaveLength(1);

    const decided = await outboxOf(deliveryId, "delivery-occurrence.authorization_decided");

    expect(decided).toHaveLength(1);
    expect(decided[0].payload).toMatchObject({
      decision: "APPROVED",
      driverUserId: users.driver.id,
      deliveryStatusAfter: "Insucesso",
      // The raw code the app's push reads (data.deliveryStatus).
      deliveryStatus: "FAILED",
    });
  });

  it("the winner repeating the same answer is a replay, with nothing written again", async () => {
    const winnerId = (
      await prisma.deliveryOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } })
    ).authorizedById;

    const token = winnerId === users.operator.id ? users.operator.token : users.admin.token;

    const again = await decide(occurrenceId, { decision: "APPROVED" }, token);

    expect(again.status).toBe(200);
    expect(again.body.data.replayed).toBe(true);
    expect(await outboxOf(deliveryId, "delivery-occurrence.authorization_decided")).toHaveLength(1);
  });

  it("left the queue", async () => {
    const queue = await call("GET", "/delivery/occurrence-authorizations", users.operator.token);

    expect(
      (queue.body.data as Array<{ id: string }>).some((row) => row.id === occurrenceId),
    ).toBe(false);
  });
});

describe("an approval racing a denial", () => {
  it("one of them stands, and the delivery says the same", async () => {
    const { deliveryId, occurrenceId } = await pendingOn("Corrida");

    const answers = await Promise.all([
      decide(occurrenceId, { decision: "APPROVED" }, users.operator.token),
      decide(occurrenceId, { decision: "DENIED", note: "Aguarde o cliente." }, users.admin.token),
    ]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);

    const winner = answers.find((answer) => answer.status === 200)!;
    const occurrence = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
    });
    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });

    expect(occurrence.authorization_status).toBe(winner.body.data.authorization_status);
    expect(delivery.status).toBe(
      winner.body.data.authorization_status === "APPROVED" ? "FAILED" : "IN_TRANSIT",
    );
    expect(await outboxOf(deliveryId, "delivery-occurrence.authorization_decided")).toHaveLength(1);
  });
});

describe("a denial", () => {
  it("applies nothing and tells the driver why", async () => {
    const { deliveryId, occurrenceId } = await pendingOn("Negada");

    const answer = await decide(
      occurrenceId,
      { decision: "DENIED", note: "Deixe com o porteiro e comprove." },
      users.operator.token,
    );

    expect(answer.status).toBe(200);
    expect(answer.body.data).toMatchObject({
      authorization_status: "DENIED",
      authorization_note: "Deixe com o porteiro e comprove.",
      deliveryStatus: "IN_TRANSIT",
    });

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });

    expect(delivery.status).toBe("IN_TRANSIT");
    expect(await outboxOf(deliveryId, "delivery-occurrence.reported")).toHaveLength(0);

    const day = await call("GET", `/delivery/my-deliveries/${CARRIER}`, users.driver.token);
    const row = (day.body.data as Array<Record<string, any>>).find(
      (entry) => entry.id === deliveryId,
    );

    expect(row?.authorization_request).toMatchObject({
      status: "DENIED",
      note: "Deixe com o porteiro e comprove.",
    });
  });
});

describe("a proof while the request waits", () => {
  it("supersedes the request, and a later decision is refused with SUPERSEDED", async () => {
    const { deliveryId, occurrenceId } = await pendingOn("Comprovada antes");

    const key = `deliveryPhotos/${CARRIER}/${Date.now()}-test-${randomUUID()}.jpg`;

    await uploads.putObject(key, fakeJpeg(), "image/jpeg");
    storedKeys.push(key);

    const proof = await call(
      "POST",
      `/delivery/proof/${deliveryId}/business/${CARRIER}`,
      users.driver.token,
      { client_submission_id: randomUUID(), photo: key, received_by: "Maria Recebedora" },
    );

    expect(proof.status).toBe(201);

    const occurrence = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
    });

    expect(occurrence.authorization_status).toBe("SUPERSEDED");

    const late = await decide(occurrenceId, { decision: "APPROVED" }, users.operator.token);

    expect(late).toMatchObject({
      status: 409,
      body: { code: "OCCURRENCE_ALREADY_DECIDED", decision: { status: "SUPERSEDED" } },
    });

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });

    expect(delivery.status).toBe("DELIVERED");
  });
});

describe("the other ways a report can go", () => {
  it("from the panel, the author authorizes it and the effect applies at once", async () => {
    const deliveryId = await inTransit("Pelo painel");

    const answer = await report(
      deliveryId,
      { occurrenceTypeId: TOWER_TYPE, form_answers: VALID_ANSWERS },
      users.operator.token,
    );

    expect(answer.status).toBe(201);
    expect(answer.body.data.authorization_status).toBe("APPROVED");

    const occurrence = await prisma.deliveryOccurrence.findUniqueOrThrow({
      where: { id: answer.body.data.id },
    });

    expect(occurrence.authorizedById).toBe(users.operator.id);

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });

    expect(delivery.status).toBe("FAILED");
    expect(await outboxOf(deliveryId, "delivery-occurrence.authorization_requested")).toHaveLength(0);

    const events = await prisma.deliveryEvent.findMany({ where: { deliveryId } });

    expect(events).toEqual([
      expect.objectContaining({ type: "OCCURRENCE", actor: "USER", occurrenceId: answer.body.data.id }),
    ]);
  });

  it("another company's delivery or type reads exactly like a missing one", async () => {
    const deliveryId = await inTransit("Muros");

    const foreignDelivery = await report(FOREIGN_DELIVERY, { occurrenceTypeId: TOWER_TYPE });
    const foreignType = await report(deliveryId, { occurrenceTypeId: FOREIGN_TYPE });

    expect(foreignDelivery).toMatchObject({ status: 404, body: { code: "DELIVERY_NOT_FOUND" } });
    expect(foreignType).toMatchObject({ status: 404, body: { code: "OCCURRENCE_TYPE_NOT_FOUND" } });
  });

  it("refuses the platform's own type", async () => {
    const deliveryId = await inTransit("Sistema");

    const answer = await report(deliveryId, { occurrenceTypeId: SYSTEM_TYPE });

    expect(answer).toMatchObject({ status: 400, body: { code: "OCCURRENCE_TYPE_NOT_REPORTABLE" } });
  });

  it("a type that asks the tower but does not block: approval changes no status", async () => {
    const deliveryId = await inTransit("Vizinho");

    const reported = await report(deliveryId, { occurrenceTypeId: TOWER_INFO_TYPE });

    expect(reported.body.data.authorization_status).toBe("PENDING");

    const approved = await decide(reported.body.data.id, { decision: "APPROVED" }, users.admin.token);

    expect(approved.body.data).toMatchObject({
      authorization_status: "APPROVED",
      deliveryStatus: "IN_TRANSIT",
    });
    expect(
      await prisma.deliveryEvent.count({ where: { deliveryId, type: "STATUS_CHANGE" } }),
    ).toBe(0);
  });

  it("a report that never asked the tower cannot be decided", async () => {
    const deliveryId = await inTransit("Sem pedido");

    const reported = await report(
      deliveryId,
      { occurrenceTypeId: EDITED_TYPE, form_answers: { volumes: 2 }, form_version: 2 },
    );

    expect(reported.body.data.authorization_status).toBe("NOT_REQUIRED");

    const answer = await decide(reported.body.data.id, { decision: "APPROVED" }, users.admin.token);

    expect(answer).toMatchObject({
      status: 409,
      body: { code: "OCCURRENCE_AUTHORIZATION_NOT_REQUIRED" },
    });
  });
});

describe("on a running route", () => {
  it("a request waiting leaves the stop open; the approval closes it and the route", async () => {
    const deliveryId = await inTransit("Parada da rota");

    const route = await prisma.route.create({
      data: {
        code: 7001,
        status: "IN_PROGRESS",
        scheduled_date: new Date(),
        started_at: new Date(Date.now() - 60 * 60 * 1000),
        businessId: CARRIER,
        driverId: DRIVER,
        stops: { create: [{ sequence: 1, deliveryId }] },
      },
      include: { stops: true },
    });

    const reported = await report(deliveryId, {
      occurrenceTypeId: TOWER_TYPE,
      form_answers: VALID_ANSWERS,
      form_version: 1,
    });

    expect(reported.body.data.authorization_status).toBe("PENDING");

    // Waiting: nothing on the route moved, and the event says which route.
    const waiting = await prisma.routeStop.findUniqueOrThrow({ where: { id: route.stops[0].id } });

    expect(waiting.status).toBe("PENDING");
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: route.id } })).status,
    ).toBe("IN_PROGRESS");
    expect(
      await prisma.deliveryEvent.findFirstOrThrow({ where: { deliveryId, type: "OCCURRENCE" } }),
    ).toMatchObject({ routeId: route.id, occurrenceId: reported.body.data.id });

    const approvedAt = Date.now();
    const approved = await decide(reported.body.data.id, { decision: "APPROVED" }, users.operator.token);

    expect(approved.status).toBe(200);

    const settled = await prisma.routeStop.findUniqueOrThrow({ where: { id: route.stops[0].id } });

    expect(settled.status).toBe("FAILED");
    // Closed at the approval, the moment the insucesso happened.
    expect(settled.completed_at!.getTime()).toBeGreaterThanOrEqual(approvedAt - 1000);

    // Its last open stop: the route ends by itself.
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: route.id } })).status,
    ).toBe("COMPLETED");
    expect(
      await prisma.deliveryEvent.findFirstOrThrow({ where: { deliveryId, type: "STATUS_CHANGE" } }),
    ).toMatchObject({ routeId: route.id, status_to: "FAILED" });
  });
});

describe("who files a request, and when its attempt is over (review r1)", () => {
  let routeCode = 7100;

  async function runningRoute(deliveryId: string): Promise<{ id: string; stopId: string }> {
    routeCode += 1;

    const route = await prisma.route.create({
      data: {
        code: routeCode,
        status: "IN_PROGRESS",
        scheduled_date: new Date(),
        started_at: new Date(Date.now() - 60 * 60 * 1000),
        businessId: CARRIER,
        driverId: DRIVER,
        stops: { create: [{ sequence: 1, deliveryId }] },
      },
      include: { stops: true },
    });

    return { id: route.id, stopId: route.stops[0].id };
  }

  const inQueue = async (occurrenceId: string): Promise<boolean> => {
    const queue = await call("GET", "/delivery/occurrence-authorizations", users.operator.token);

    expect(queue.status).toBe(200);

    return (queue.body.data as Array<{ id: string }>).some((row) => row.id === occurrenceId);
  };

  it("the panel cancels the delivery: out of the queue, and a late approval closes it", async () => {
    const { deliveryId, occurrenceId } = await pendingOn("Cancelada pelo painel");

    expect(await inQueue(occurrenceId)).toBe(true);

    const cancelled = await call(
      "PATCH",
      `/delivery/update-delivery-status/${deliveryId}/business/${CARRIER}`,
      users.operator.token,
      { status: "CANCELLED", reasonId: statusReasonId },
    );

    expect(cancelled.status).toBe(200);
    expect(await inQueue(occurrenceId)).toBe(false);

    const late = await decide(occurrenceId, { decision: "APPROVED" }, users.admin.token);

    expect(late).toMatchObject({
      status: 409,
      body: { code: "OCCURRENCE_ALREADY_DECIDED", decision: { status: "SUPERSEDED" } },
    });

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });

    expect(delivery.status).toBe("CANCELLED");
    expect(await outboxOf(deliveryId, "delivery-occurrence.authorization_decided")).toHaveLength(0);
  });

  it("a route cancelled under the request: a late approval fails nothing", async () => {
    const deliveryId = await inTransit("Rota cancelada");
    const route = await runningRoute(deliveryId);

    const reported = await report(deliveryId, {
      occurrenceTypeId: TOWER_TYPE,
      form_answers: VALID_ANSWERS,
      form_version: 1,
    });

    expect(reported.body.data.authorization_status).toBe("PENDING");

    const occurrenceId = reported.body.data.id as string;

    const cancelled = await call(
      "PATCH",
      `/route/cancel-route/${route.id}/business/${CARRIER}`,
      users.operator.token,
      { reason: "Caminhão quebrou na saída" },
    );

    expect(cancelled.status).toBe(200);

    // The load is back in the pool, off the driver.
    expect(await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } })).toMatchObject({
      status: "PENDING",
      driverId: null,
    });
    expect(await inQueue(occurrenceId)).toBe(false);

    const late = await decide(occurrenceId, { decision: "APPROVED" }, users.operator.token);

    expect(late).toMatchObject({
      status: 409,
      body: { code: "OCCURRENCE_ALREADY_DECIDED", decision: { status: "SUPERSEDED" } },
    });

    const after = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });

    expect(after.status).toBe("PENDING");
    expect(await webhooksAbout(deliveryId, "delivery.failed")).toHaveLength(0);
    expect(
      await prisma.deliveryEvent.count({ where: { deliveryId, type: "STATUS_CHANGE" } }),
    ).toBe(0);
  });

  it("the delivery already on its next route: the old request cannot fail it nor close the new stop", async () => {
    const deliveryId = await inTransit("Rota seguinte");
    const first = await runningRoute(deliveryId);

    const reported = await report(deliveryId, {
      occurrenceTypeId: TOWER_TYPE,
      form_answers: VALID_ANSWERS,
      form_version: 1,
    });

    const occurrenceId = reported.body.data.id as string;

    await call("PATCH", `/route/cancel-route/${first.id}/business/${CARRIER}`, users.operator.token, {
      reason: "Replanejada para a tarde",
    });

    // Out again, same driver, on a new route (the departure's own writes).
    const second = await runningRoute(deliveryId);

    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "IN_TRANSIT", driverId: DRIVER },
    });

    expect(await inQueue(occurrenceId)).toBe(false);

    const late = await decide(occurrenceId, { decision: "APPROVED" }, users.operator.token);

    expect(late).toMatchObject({ status: 409, body: { decision: { status: "SUPERSEDED" } } });
    expect((await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } })).status).toBe(
      "IN_TRANSIT",
    );
    expect(
      (await prisma.routeStop.findUniqueOrThrow({ where: { id: second.stopId } })).status,
    ).toBe("PENDING");
    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: second.id } })).status,
    ).toBe("IN_PROGRESS");
  });

  it("a profile that reports but only reads deliveries files a request from the panel", async () => {
    const deliveryId = await inTransit("Pelo escritório");

    const reported = await report(
      deliveryId,
      { occurrenceTypeId: TOWER_TYPE, form_answers: VALID_ANSWERS },
      users.clerk.token,
    );

    expect(reported.status).toBe(201);
    expect(reported.body.data.authorization_status).toBe("PENDING");

    const occurrenceId = reported.body.data.id as string;

    // Nothing applied, nobody authorized it.
    expect(
      await prisma.deliveryOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ authorization_status: "PENDING", authorizedById: null });
    expect((await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } })).status).toBe(
      "IN_TRANSIT",
    );
    expect(await webhooksAbout(deliveryId, "delivery.failed")).toHaveLength(0);

    // The queue asks the tower, and the clerk is not the tower there either.
    expect(await inQueue(occurrenceId)).toBe(true);

    const byClerk = await decide(occurrenceId, { decision: "APPROVED" }, users.clerk.token);

    expect(byClerk).toMatchObject({ status: 403, body: { code: "PERMISSION_DENIED" } });

    // Not the driver's request: the driver's card does not carry it.
    const day = await call("GET", `/delivery/my-deliveries/${CARRIER}`, users.driver.token);
    const row = (day.body.data as Array<Record<string, any>>).find(
      (entry) => entry.id === deliveryId,
    );

    expect(row?.authorization_request).toBeNull();

    const approved = await decide(occurrenceId, { decision: "APPROVED" }, users.operator.token);

    expect(approved.body.data).toMatchObject({
      authorization_status: "APPROVED",
      deliveryStatus: "FAILED",
    });
  });

  it("a panel self-approval is not shown to the driver as their request", async () => {
    const deliveryId = await inTransit("Autorizada no painel");

    const reported = await report(
      deliveryId,
      { occurrenceTypeId: TOWER_INFO_TYPE },
      users.operator.token,
    );

    expect(reported.body.data.authorization_status).toBe("APPROVED");

    const day = await call("GET", `/delivery/my-deliveries/${CARRIER}`, users.driver.token);
    const row = (day.body.data as Array<Record<string, any>>).find(
      (entry) => entry.id === deliveryId,
    );

    expect(row).toBeDefined();
    expect(row?.authorization_request).toBeNull();
  });

  it("a delivery handed over to another driver does not show them the first driver's request", async () => {
    const { deliveryId, occurrenceId } = await pendingOn("Trocou de motorista");

    const denied = await decide(
      occurrenceId,
      { decision: "DENIED", note: "Tente de novo amanhã." },
      users.operator.token,
    );

    expect(denied.status).toBe(200);

    const cardOf = async (token: string) => {
      const day = await call("GET", `/delivery/my-deliveries/${CARRIER}`, token);

      expect(day.status).toBe(200);

      return (day.body.data as Array<Record<string, any>>).find(
        (entry) => entry.id === deliveryId,
      );
    };

    // The dispatcher hands the delivery over to another driver.
    await prisma.delivery.update({ where: { id: deliveryId }, data: { driverId: OTHER_DRIVER } });

    const handedOver = await cardOf(users.otherDriver.token);

    expect(handedOver).toBeDefined();
    expect(handedOver?.authorization_request).toBeNull();

    // What they ask themselves is theirs to see.
    const own = await report(
      deliveryId,
      { occurrenceTypeId: TOWER_INFO_TYPE },
      users.otherDriver.token,
    );

    expect(own.body.data.authorization_status).toBe("PENDING");
    expect((await cardOf(users.otherDriver.token))?.authorization_request).toMatchObject({
      occurrenceId: own.body.data.id,
      status: "PENDING",
    });
  });

  it("on a delivery that already FAILED, the request is born SUPERSEDED", async () => {
    const deliveryId = await inTransit("Já com insucesso");

    await prisma.delivery.update({ where: { id: deliveryId }, data: { status: "FAILED" } });

    const reported = await report(deliveryId, {
      occurrenceTypeId: TOWER_TYPE,
      form_answers: VALID_ANSWERS,
      form_version: 1,
    });

    expect(reported.status).toBe(201);
    expect(reported.body.data.authorization_status).toBe("SUPERSEDED");
    expect(
      await outboxOf(deliveryId, "delivery-occurrence.authorization_requested"),
    ).toHaveLength(0);
  });

  it("a driver build without forms is told to update, with the current form; nothing is stored", async () => {
    const deliveryId = await inTransit("App antigo");

    const legacy = await report(deliveryId, { occurrenceTypeId: TOWER_TYPE });

    expect(legacy).toMatchObject({
      status: 400,
      body: {
        code: "CLIENT_OUTDATED",
        form_version: 1,
        form_fields: [
          expect.objectContaining({ key: "quem_atendeu" }),
          expect.objectContaining({ key: "ligou_cliente" }),
          expect.objectContaining({ key: "motivo" }),
        ],
      },
    });

    // A build that shows forms and sent nothing is plainly wrong answers.
    const current = await report(deliveryId, { occurrenceTypeId: TOWER_TYPE, form_version: 1 });

    expect(current).toMatchObject({ status: 400, body: { code: "OCCURRENCE_FORM_INVALID" } });
    expect(await prisma.deliveryOccurrence.count({ where: { deliveryId } })).toBe(0);
  });

  it("a request decided before its notice fans out rings nobody; one still waiting reaches the tower", async () => {
    const { NotificationPipelineService } = await import(
      "@/shared/notifications/notification-pipeline-service"
    );
    const pipeline = NotificationPipelineService.getInstance();

    // The order under test is "decided, THEN expanded". A publish wakes this
    // process's worker 500 ms after its commit, and that wake raced the
    // decision below (review r2: red in 3 of 4 full-file runs, fix or not).
    // Hold every wake, including one an earlier test already scheduled (its
    // timer looks `wake` up when it fires), and let a cycle already in
    // flight finish its batch: from then on only this test claims events.
    // Production has the same shape: an HTTP-only replica publishes, and the
    // worker's sweep expands the event later.
    const heldWake = vi.spyOn(pipeline, "wake").mockImplementation(() => undefined);

    try {
      await vi.waitFor(
        () =>
          expect((pipeline as unknown as { outboxRunning: unknown }).outboxRunning).toBe(false),
        { timeout: 15_000, interval: 50 },
      );

      const waiting = await pendingOn("Aviso ainda vale");
      const decided = await pendingOn("Aviso superado");

      const denied = await decide(
        decided.occurrenceId,
        { decision: "DENIED", note: "Resolvido por telefone." },
        users.operator.token,
      );

      expect(denied.status).toBe(200);

      const noticeOf = async (deliveryId: string) => {
        const [event] = await outboxOf(deliveryId, "delivery-occurrence.authorization_requested");

        return event;
      };

      // Neither notice was expanded yet: the decision came first.
      expect((await noticeOf(decided.deliveryId)).status).toBe("PENDING");
      expect((await noticeOf(waiting.deliveryId)).status).toBe("PENDING");

      await pipeline.runOutboxCycle();

      const stale = await noticeOf(decided.deliveryId);
      const live = await noticeOf(waiting.deliveryId);

      expect(stale.status).toBe("PUBLISHED");
      expect(live.status).toBe("PUBLISHED");

      expect(
        await prisma.notificationDelivery.count({ where: { outboxEventId: stale.id } }),
      ).toBe(0);

      const reached = await prisma.notificationDelivery.findMany({
        where: { outboxEventId: live.id },
        select: { userId: true },
      });

      expect(new Set(reached.map((row) => row.userId))).toEqual(
        new Set([users.admin.id, users.operator.id]),
      );
    } finally {
      heldWake.mockRestore();
    }
  });

  it("a report racing the proof never leaves a request waiting on a delivered delivery", async () => {
    for (let round = 0; round < 4; round += 1) {
      const deliveryId = await inTransit(`Corrida com a prova ${round}`);
      const key = `deliveryPhotos/${CARRIER}/${Date.now()}-race-${randomUUID()}.jpg`;

      await uploads.putObject(key, fakeJpeg(), "image/jpeg");
      storedKeys.push(key);

      const [reported, proof] = await Promise.all([
        report(deliveryId, {
          occurrenceTypeId: TOWER_TYPE,
          form_answers: VALID_ANSWERS,
          form_version: 1,
        }),
        call("POST", `/delivery/proof/${deliveryId}/business/${CARRIER}`, users.driver.token, {
          client_submission_id: randomUUID(),
          photo: key,
          received_by: "Maria Recebedora",
        }),
      ]);

      expect(reported.status).toBe(201);
      expect(proof.status).toBe(201);

      const occurrence = await prisma.deliveryOccurrence.findUniqueOrThrow({
        where: { id: reported.body.data.id },
      });

      expect(occurrence.authorization_status).toBe("SUPERSEDED");
    }
  });
});
