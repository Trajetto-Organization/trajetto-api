import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import auth from "@/config/auth";
import { importQueue } from "@/modules/import/services/import-queue";

/**
 * The acceptance criterion of Fase 2, made executable.
 *
 * The plan states it in one sentence: "importação (planilha ou XML) → rota →
 * execução no app → evidência → comprovante verificável → cliente notificado →
 * webhook disparado, com o módulo desligável por entitlement". Every stage of
 * that sentence has a focused test of its own — the import loop, the route
 * lifecycle, the proof document and its public verification, the webhook
 * dispatcher. What none of them can show is that the stages are WIRED: that a
 * route the importer created is a route the driver can start, that finishing
 * the last stop closes the route without anybody asking, and that the events
 * the integration layer sells actually land in the outbox along the way.
 *
 * So this file is deliberately one long test, in order, over real HTTP. A
 * failure anywhere in it means the product does not do the thing it is sold as
 * doing, even when every part passes alone.
 *
 * The one thing stood in for is the storage bucket: the presigned flow puts
 * the bytes there directly and the API only resolves keys, so `UploadService`
 * is replaced with a stand-in that answers as though the objects exist.
 * Everything else — routing, middleware, entitlements, permissions, the
 * transaction boundaries, the outbox — is the real thing.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fa000-0000-7000-8000-00000000000a";
const SHIPPER = "018fa000-0000-7000-8000-0000000000f1";
const DRIVER = "018fa000-0000-7000-8000-0000000000d1";

const CNH = "11223344556";

let managerToken = "";
let driverToken = "";
let routeId = "";
let vehicleId = "";

/** The deliveries the import created, in the order the route visits them. */
let stops: Array<{ stopId: string; deliveryId: string }> = [];

async function seedUser(
  role: "BUSINESS_ADMIN" | "BUSINESS_USER",
  driverId?: string,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: role === "BUSINESS_USER" ? "Motorista" : "Gestora",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId: CARRIER,
      driverId: driverId ?? null,
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

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "30m" },
  );
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Fluxo",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222444000199",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `fluxo-${randomUUID()}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista do Fluxo",
      birth_date: new Date("1990-01-01"),
      cnh: CNH,
      cpf: `${DRIVER}-cpf`,
      rg: `${DRIVER}-rg`,
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

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador do Fluxo", businessId: CARRIER },
  });

  /**
   * The carrier chose to tell its customers that the load left.
   *
   * A channel without an active template for the moment is a decision not to
   * send (DLVP-NOTIF-2): no recipient, no rows. Without this row the
   * customer-facing half of the criterion would expand into nothing and step
   * 11 would be asserting a notice the carrier never configured.
   */
  await prisma.deliveryMessageTemplate.create({
    data: {
      businessId: CARRIER,
      topic: "DISPATCHED",
      channel: "WHATSAPP",
      body: "Sua entrega saiu. {{link}} Sair: {{link_descadastro}}",
    },
  });

  /**
   * A truck, because a route cannot leave without one.
   *
   * The release refuses a route with no vehicle — "defina o veículo da rota
   * antes de liberá-la" — which is the product being right: a day's work
   * assigned to nothing is a plan, not a route.
   */
  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial do Fluxo ${randomUUID().slice(0, 6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "11222444000288",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId: CARRIER,
    },
  });

  const vehicleType = await prisma.vehicleType.create({
    data: {
      description: `Tipo ${randomUUID().slice(0, 6)}`,
      number_of_axles: 2,
      businessId: CARRIER,
    },
  });

  const fuelType = await prisma.fuelType.create({
    data: {
      description: `Combustível ${randomUUID().slice(0, 6)}`,
      businessId: CARRIER,
    },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      license_plate: randomUUID().slice(0, 7).toUpperCase(),
      description: "Caminhão do Fluxo",
      brand: "Marca",
      model: "Modelo",
      acquisition_date: new Date("2020-01-01"),
      fleet_type: "OWNED",
      current_mileage: 10_000,
      maintenance_interval_km: 10_000,
      maintenance_interval_months: 6,
      renavam: randomUUID().slice(0, 11),
      manufacturing_year: new Date("2019-01-01"),
      model_year: new Date("2020-01-01"),
      km_per_liter: 3,
      number_of_axles: 2,
      status: "ACTIVE",
      businessId: CARRIER,
      branchId: branch.id,
      vehicleTypeId: vehicleType.id,
      fuelTypeId: fuelType.id,
      driverId: DRIVER,
    },
  });

  vehicleId = vehicle.id;

  /**
   * Somebody's ERP, subscribed.
   *
   * Without an endpoint there is nothing to fan out to and `announce` writes
   * no rows, so the last leg of the phase criterion — "webhook disparado" —
   * would be untested while looking covered. The URL is never called here:
   * the dispatcher claims and sends on its own schedule, and what this file
   * asserts is that the rows were queued with the right topics.
   */
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP do cliente",
      url: "https://erp.exemplo.com.br/trajetto/webhook",
      secret: "segredo-do-teste",
      businessId: CARRIER,
      topics: [
        "route.released",
        "route.started",
        "route.completed",
        "delivery.delivered",
        "proof.registered",
      ],
    },
  });

  managerToken = await seedUser("BUSINESS_ADMIN");
  driverToken = await seedUser("BUSINESS_USER", DRIVER);

  ({ app } = await import("@/http"));
  await app.ready();

  /**
   * The bucket, stood in for.
   *
   * The presigned flow means the bytes never pass through the API: the app
   * PUTs them straight to storage and sends only the key, which the use case
   * resolves — checking the prefix, the ownership and the size against the
   * bucket. There is no bucket here, and seeding one would be testing the
   * storage provider rather than the flow.
   *
   * Registered AFTER `@/http`, and that ordering is the whole trick:
   * `src/shared/index.ts` registers the real UploadService as a singleton
   * while the app is being imported, so anything registered before is simply
   * overwritten — which is how the first run of this file got a 403 saying
   * the uploaded file belonged to another company. The controllers resolve
   * per request, so replacing it now still reaches them.
   */
  const stored = new Map<string, Buffer>();

  container.registerInstance("UploadService", {
    resolvePresignedUploads: async (
      photos: Array<{ key: string; fieldName?: string }>,
    ) =>
      photos.map((photo) => ({ path: photo.key, fieldName: photo.fieldName })),
    deleteFile: async () => undefined,
    getSignedUrl: async (path: string) => `https://storage.invalid/${path}`,
    getFileUrl: async (path: string) => `https://storage.invalid/${path}`,

    // The receipt renderer reads the slip and writes the PDF. An in-memory
    // map is enough: what matters downstream is that the bytes it stored are
    // the bytes the hash was taken over, which the public verification then
    // checks for real.
    readObject: async (key: string) => stored.get(key) ?? null,
    putObject: async (key: string, bytes: Buffer) => {
      stored.set(key, Buffer.from(bytes));
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

/**
 * A function, not a constant.
 *
 * A module-level object would capture `managerToken` while it is still the
 * empty string — every request would go out as `Bearer ` and the whole file
 * would fail on authentication rather than on anything it means to test.
 */
const asManager = () => ({ authorization: `Bearer ${managerToken}` });

const asDriver = () => ({ authorization: `Bearer ${driverToken}` });

/**
 * One line of the published import model.
 *
 * The recipient's phone and e-mail are not decoration. Nothing downstream
 * tells the customer anything without them: `start-route` skips the outbox row
 * on purpose for a delivery with nobody to tell, so a spreadsheet without
 * contact details produces a route that runs perfectly and notifies nobody —
 * and a test built on one would report the customer-facing half of the phase
 * criterion as covered while never exercising it.
 */
function row(recipient: string, order: string): string[] {
  return [
    recipient,
    `cliente-${order.toLowerCase()}@exemplo.com.br`,
    "11987654321",
    "01001000",
    "São Paulo",
    "SP",
    "Praça da Sé",
    order,
    "Rota do dia",
    CNH,
  ];
}

const HEADER = [
  "Destinatário",
  "E-mail",
  "Telefone",
  "CEP",
  "Cidade",
  "UF",
  "Logradouro",
  "Pedido",
  "Rota",
  "CNH do motorista",
];

/** The endpoint takes the file as base64, the same as a real upload. */
function csv(rows: string[][]): string {
  const text = [HEADER, ...rows]
    .map((line) => line.map((cell) => `"${cell}"`).join(";"))
    .join("\n");

  return Buffer.from(text, "utf8").toString("base64");
}

describe("a carrier's day, from the spreadsheet to the webhook", () => {
  it("1. loads the day from a spreadsheet and creates the route", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/import/import-spreadsheet/${CARRIER}`,
      headers: asManager(),
      payload: {
        filename: "dia.csv",
        content: csv([
          row("Padaria Central", "PED-001"),
          row("Mercado da Esquina", "PED-002"),
          row("Farmácia do Bairro", "PED-003"),
        ]),
        shipperId: SHIPPER,
      },
    });

    // Accepted and processed after the answer (import-queue.ts); the report
    // is read from the record, as the web follows it.
    expect(response.statusCode, response.body.slice(0, 400)).toBe(202);

    await importQueue.idle();

    const detail = await app.inject({
      method: "GET",
      url: `/import/get-import/${response.json().data.id}/business/${CARRIER}`,
      headers: asManager(),
    });

    expect(detail.statusCode, detail.body.slice(0, 400)).toBe(200);

    const body = detail.json();

    expect(body.data.status).toBe("COMPLETED");
    expect(body.data.imported).toBe(3);

    // The route column is what makes this the entry path for a carrier with
    // no integration: one upload becomes a day of work, already assigned.
    expect(body.data.report.routes).toHaveLength(1);

    const created = await prisma.route.findFirstOrThrow({
      where: { businessId: CARRIER },
      include: { stops: { orderBy: { sequence: "asc" } } },
    });

    routeId = created.id;

    expect(created.status).toBe("PLANNED");
    expect(created.driverId).toBe(DRIVER);
    expect(created.stops).toHaveLength(3);

    stops = created.stops.map((stop) => ({
      stopId: stop.id,
      deliveryId: stop.deliveryId,
    }));
  });

  it("2. reorders the stops before anybody leaves", async () => {
    const reversed = [...stops].reverse();

    const response = await app.inject({
      method: "PATCH",
      url: `/route/reorder-stops/${routeId}/business/${CARRIER}`,
      headers: asManager(),
      payload: { orderedStopIds: reversed.map((stop) => stop.stopId) },
    });

    expect(response.statusCode, response.body.slice(0, 400)).toBe(200);

    const after = await prisma.routeStop.findMany({
      where: { routeId },
      orderBy: { sequence: "asc" },
    });

    expect(after.map((stop) => stop.id)).toEqual(
      reversed.map((stop) => stop.stopId),
    );

    stops = reversed;
  });

  it("3. assigns the truck the day will actually go out on", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/route/update-route/${routeId}/business/${CARRIER}`,
      headers: asManager(),
      payload: { vehicleId },
    });

    expect(response.statusCode, response.body.slice(0, 400)).toBe(200);

    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: routeId } }))
        .vehicleId,
    ).toBe(vehicleId);
  });

  it("4. releases the route to the driver", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/route/release-route/${routeId}/business/${CARRIER}`,
      headers: asManager(),

      // The body is all-optional but not optional: zod parses `request.body`,
      // and with no payload at all that is `undefined`.
      payload: {},
    });

    expect(response.statusCode, response.body.slice(0, 400)).toBe(200);

    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: routeId } })).status,
    ).toBe("RELEASED");
  });

  it("5. the driver sees it and starts it", async () => {
    const mine = await app.inject({
      method: "GET",
      url: `/delivery/my-deliveries/${CARRIER}`,
      headers: asDriver(),
    });

    expect(mine.statusCode, mine.body.slice(0, 400)).toBe(200);

    const start = await app.inject({
      method: "POST",
      url: `/route/start-route/${routeId}/business/${CARRIER}`,
      headers: asDriver(),
      payload: {},
    });

    expect(start.statusCode, start.body.slice(0, 400)).toBe(200);

    expect(
      (await prisma.route.findUniqueOrThrow({ where: { id: routeId } })).status,
    ).toBe("IN_PROGRESS");
  });

  it("6. works the stops in order: arrival, then proof", async () => {
    /**
     * With no stops, the loop below runs zero times and the test reports
     * green — which is exactly what happened the first time this file ran,
     * while the import was silently rejecting every row for being sent as
     * plain text where the endpoint expects base64.
     */
    expect(stops.length, "nenhuma parada para trabalhar").toBe(3);

    for (const stop of stops) {
      const arrival = await app.inject({
        method: "POST",
        url: `/delivery/arrival/${stop.deliveryId}/business/${CARRIER}`,
        headers: asDriver(),
        payload: {
          client_submission_id: randomUUID(),
          latitude: -23.550519,
          longitude: -46.633308,
        },
      });

      expect(
        arrival.statusCode,
        `chegada em ${stop.deliveryId}: ${arrival.body.slice(0, 300)}`,
      ).toBe(201);

      const proof = await app.inject({
        method: "POST",
        url: `/delivery/proof/${stop.deliveryId}/business/${CARRIER}`,
        headers: asDriver(),
        payload: {
          client_submission_id: randomUUID(),
          photo: `deliveryProofs/${stop.deliveryId}/canhoto.webp`,
          received_by: "Maria Souza",
        },
      });

      expect(
        proof.statusCode,
        `comprovação de ${stop.deliveryId}: ${proof.body.slice(0, 300)}`,
      ).toBe(201);
    }

    const delivered = await prisma.delivery.findMany({
      where: { id: { in: stops.map((stop) => stop.deliveryId) } },
      select: { status: true },
    });

    expect(delivered.every((delivery) => delivery.status === "DELIVERED")).toBe(
      true,
    );
  });

  it("7. closes the route on its own once the last stop is done", async () => {
    // Nobody pressed anything: the route ends because its work ended. A
    // dispatcher having to close it by hand is how a day ends up looking open
    // for a week.
    const closed = await prisma.route.findUniqueOrThrow({
      where: { id: routeId },
    });

    expect(closed.status).toBe("COMPLETED");
    expect(closed.completed_at).not.toBeNull();
  });

  it("8. produced a receipt the customer can verify without logging in", async () => {
    const document = await app.inject({
      method: "GET",
      url: `/delivery/proof-document/${stops[0].deliveryId}/business/${CARRIER}`,
      headers: asManager(),
    });

    expect(document.statusCode, document.body.slice(0, 400)).toBe(200);

    const stored = await prisma.deliveryProofDocument.findFirstOrThrow({
      where: { deliveryId: stops[0].deliveryId },
    });

    expect(stored.sha256).toBeTruthy();

    const verification = await app.inject({
      method: "GET",
      url: `/public/verify-proof/${stored.verification_token}`,
    });

    expect(verification.statusCode, verification.body.slice(0, 300)).toBe(200);
  });

  it("9. told the customer their delivery was on its way, and then arrived", async () => {
    const events = await prisma.domainOutboxEvent.findMany({
      where: { businessId: CARRIER },
      select: { topic: true },
    });

    const seen = Array.from(new Set(events.map((event) => event.topic)));

    /**
     * The customer-facing half, which is a different pipeline from the
     * webhooks below.
     *
     * The domain outbox is what expands into a WhatsApp message or an e-mail
     * to the person receiving the delivery. `route.started` is NOT here and
     * that is correct — it is an integration event, not something the
     * recipient is told. Asserting it here was this test's own mistake.
     */
    expect(seen, `vistos: ${seen.join(", ")}`).toContain("route.released");
    expect(seen, `vistos: ${seen.join(", ")}`).toContain("delivery.dispatched");
    expect(seen, `vistos: ${seen.join(", ")}`).toContain("delivery.delivered");
  });

  it("10. queued the webhooks the subscriber wired", async () => {
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { businessId: CARRIER },
      select: { topic: true, signature: true },
    });

    const topics = Array.from(new Set(deliveries.map((row) => row.topic)));

    /**
     * By name, because "some route topic arrived" is not the promise.
     *
     * An ERP wires these individually: the route left the yard, the document
     * was delivered, the receipt exists. A subscriber who receives
     * `route.released` and nothing else has an integration that reports every
     * load as still in the yard.
     */
    expect(topics, `vistos: ${topics.join(", ")}`).toContain("route.released");
    expect(topics, `vistos: ${topics.join(", ")}`).toContain("route.started");
    expect(topics, `vistos: ${topics.join(", ")}`).toContain("route.completed");
    expect(topics, `vistos: ${topics.join(", ")}`).toContain(
      "delivery.delivered",
    );
    expect(topics, `vistos: ${topics.join(", ")}`).toContain(
      "proof.registered",
    );

    // Every row is signed before it is queued: the signature is what the
    // receiver checks, and a row queued without one can never be verified.
    expect(deliveries.every((row) => row.signature.length > 0)).toBe(true);
  });

  it("11. created the customer-side recipient the messages go to", async () => {
    // The person receiving a delivery is not a `User` and never will be, so
    // the pipeline grows an external recipient for them. Without this row the
    // events above expand into nothing.
    const recipients = await prisma.externalRecipient.count({
      where: { businessId: CARRIER },
    });

    expect(recipients).toBeGreaterThan(0);
  });

  it("12. goes dark the moment the module is switched off", async () => {
    await prisma.businessEntitlement.updateMany({
      where: { businessId: CARRIER, module: "DELIVERIES" },
      data: { enabled: false },
    });

    const refused = await app.inject({
      method: "GET",
      url: `/route/get-route/${routeId}/business/${CARRIER}`,
      headers: asManager(),
    });

    // The whole module is sold as switchable. If the gate only covered the
    // routes somebody remembered, a carrier who stopped paying would keep the
    // half nobody listed.
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("MODULE_NOT_ENABLED");

    await prisma.businessEntitlement.updateMany({
      where: { businessId: CARRIER, module: "DELIVERIES" },
      data: { enabled: true },
    });
  });
});
