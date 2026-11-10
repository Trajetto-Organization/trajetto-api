import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@/shared/database/database-client";

import { seedFleetDriver, seedUser } from "./support/fleet-driver-seed";
import { seedJourneyRoute } from "./support/journey-route-seed";

/**
 * The generic pause's reason, over real HTTP and Postgres (owner,
 * 09/11/2026; no migration).
 *
 * - A NEW start of the seeded "Outra pausa" (by its id or by the legacy
 *   `kind: OTHER`) whose note has fewer than 3 non-space characters is
 *   refused with 400 PAUSE_NOTE_REQUIRED, in the body and in x-error-code,
 *   and nothing is written — only from a build whose form asks for it
 *   (contract 7 on, in x-trajetto-client-version) sending now (no
 *   X-Client-Queued-At).
 * - The offline queue's start, a build without the header (the web, mobile
 *   `main`) and contract 6 are recorded without a reason.
 * - A company type of the OTHER nature never asks; a reason is stored
 *   cleaned; an end that creates the pause closed never asks.
 * - The driver's day says which type asks (`requires_note`).
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe1e9-0000-7000-8000-00000000000a";

const CONTRACT_7 =
  "platform=android; version=1.7.0; build=70; runtime=e2e; update=embedded; contract=7; outbox=1";
const CONTRACT_6 =
  "platform=android; version=1.6.0; build=60; runtime=e2e; update=embedded; contract=6; outbox=1";

const startPath = `/driver-pause/start/${CARRIER}`;
const endPath = `/driver-pause/end/${CARRIER}`;

const REFUSAL =
  "Para uma pausa por outro motivo, escreva o motivo na observação, com pelo menos 3 letras.";

function post(
  path: string,
  token: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: path,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload,
  });
}

/** A driver of its own per scenario, on the street (decision 14.4). */
async function newDriver(name: string): Promise<{ id: string; token: string }> {
  const driver = await prisma.driver.create({
    data: {
      name,
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
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

  const user = await seedUser(prisma, CARRIER, "BUSINESS_USER", driver.id);

  await seedJourneyRoute(prisma, CARRIER, driver.id);

  return { id: driver.id, token: user.token };
}

const pausesOf = (driverId: string) =>
  prisma.driverPause.findMany({
    where: { driverId },
    select: { note: true, occurrenceTypeId: true, kind: true },
  });

/** The company's seeded generic pause, renamed as a company may. */
let otherTypeId: string;
let bathroomTypeId: string;

beforeAll(async () => {
  const seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "11222555000206",
  });

  ({ app } = await import("@/http"));
  await app.ready();

  // The driver's day seeds the defaults (decision 14.4).
  const day = await app.inject({
    method: "GET",
    url: `/delivery/my-deliveries/${CARRIER}`,
    headers: { authorization: `Bearer ${seed.driverToken}` },
  });

  expect(day.statusCode, day.body).toBe(200);

  const other = await prisma.occurrenceType.update({
    where: {
      businessId_system_key: { businessId: CARRIER, system_key: "pause_other" },
    },
    data: { name: "Parada diversa" },
    select: { id: true },
  });

  otherTypeId = other.id;

  const bathroom = await prisma.occurrenceType.create({
    data: {
      name: "Banheiro",
      category: "PAUSE",
      pause_kind: "OTHER",
      requires_receipt_photo: false,
      businessId: CARRIER,
    },
    select: { id: true },
  });

  bathroomTypeId = bathroom.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a new generic pause from contract 7, sent now", () => {
  it("is refused without a reason, with the code in the body and the header, and nothing is written", async () => {
    const driver = await newDriver("Sem Motivo");

    for (const payload of [
      { occurrence_type_id: otherTypeId },
      { kind: "OTHER" },
      { occurrence_type_id: otherTypeId, note: "  a   b " },
      { occurrence_type_id: otherTypeId, note: "WC" },
    ]) {
      const refused = await post(
        startPath,
        driver.token,
        { ...payload, start_submission_id: randomUUID() },
        { "x-trajetto-client-version": CONTRACT_7 },
      );

      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.headers["x-error-code"]).toBe("PAUSE_NOTE_REQUIRED");
      expect(refused.json()).toMatchObject({
        code: "PAUSE_NOTE_REQUIRED",
        message: REFUSAL,
      });
    }

    expect(await pausesOf(driver.id)).toEqual([]);
  });

  it("is taken with a reason, stored cleaned", async () => {
    const driver = await newDriver("Com Motivo");

    const taken = await post(
      startPath,
      driver.token,
      {
        occurrence_type_id: otherTypeId,
        start_submission_id: randomUUID(),
        note: "  Pneu   furado ",
      },
      { "x-trajetto-client-version": CONTRACT_7 },
    );

    expect(taken.statusCode, taken.body).toBe(201);
    expect(taken.json().pause).toMatchObject({
      kind: "OTHER",
      note: "Pneu furado",
      occurrence_type: { id: otherTypeId, name: "Parada diversa" },
    });
    expect(await pausesOf(driver.id)).toEqual([
      { note: "Pneu furado", occurrenceTypeId: otherTypeId, kind: "OTHER" },
    ]);
  });
});

describe("a generic pause recorded without a reason", () => {
  it("from the offline queue (X-Client-Queued-At)", async () => {
    const driver = await newDriver("Pausa da Fila");

    const queued = await post(
      startPath,
      driver.token,
      { occurrence_type_id: otherTypeId, start_submission_id: randomUUID() },
      {
        "x-trajetto-client-version": CONTRACT_7,
        "x-client-queued-at": new Date().toISOString(),
      },
    );

    expect(queued.statusCode, queued.body).toBe(201);
    expect(await pausesOf(driver.id)).toEqual([
      { note: null, occurrenceTypeId: otherTypeId, kind: "OTHER" },
    ]);
  });

  it("from a build without the header, and from contract 6", async () => {
    for (const headers of [
      {},
      { "x-trajetto-client-version": CONTRACT_6 },
    ] as Array<Record<string, string>>) {
      const driver = await newDriver("Pausa Antiga");

      const taken = await post(
        startPath,
        driver.token,
        { kind: "OTHER", start_submission_id: randomUUID() },
        headers,
      );

      expect(taken.statusCode, taken.body).toBe(201);
      expect(await pausesOf(driver.id)).toEqual([
        { note: null, occurrenceTypeId: otherTypeId, kind: "OTHER" },
      ]);
    }
  });
});

describe("what the reason never refuses", () => {
  it("a company type of the OTHER nature", async () => {
    const driver = await newDriver("Pausa Banheiro");

    const taken = await post(
      startPath,
      driver.token,
      { occurrence_type_id: bathroomTypeId, start_submission_id: randomUUID() },
      { "x-trajetto-client-version": CONTRACT_7 },
    );

    expect(taken.statusCode, taken.body).toBe(201);
  });

  it("an end that creates the generic pause closed, from contract 7", async () => {
    const driver = await newDriver("Fim Primeiro");
    const startKey = randomUUID();
    const tapped = new Date(Date.now() - 10 * 60_000).toISOString();

    const ended = await post(
      endPath,
      driver.token,
      {
        start_submission_id: startKey,
        end_submission_id: randomUUID(),
        start: { occurrence_type_id: otherTypeId, occurred_at: tapped },
      },
      { "x-trajetto-client-version": CONTRACT_7 },
    );

    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json().pause).toMatchObject({ note: null, kind: "OTHER" });

    // The late start, sent at the tap, finds it before any rule.
    const late = await post(
      startPath,
      driver.token,
      {
        occurrence_type_id: otherTypeId,
        start_submission_id: startKey,
        occurred_at: tapped,
      },
      { "x-trajetto-client-version": CONTRACT_7 },
    );

    expect(late.statusCode, late.body).toBe(200);
    expect(late.json()).toMatchObject({
      replayed: true,
      pause: { id: ended.json().pause.id },
    });
  });
});

describe("the driver's day", () => {
  it("says which pause type asks for a reason: only the generic one, renamed too", async () => {
    const driver = await newDriver("Lê o Dia");

    const day = await app.inject({
      method: "GET",
      url: `/delivery/my-deliveries/${CARRIER}`,
      headers: { authorization: `Bearer ${driver.token}` },
    });

    expect(day.statusCode, day.body).toBe(200);
    expect(
      day
        .json()
        .pause_types.map(
          (type: { name: string; requires_note: boolean }) =>
            [type.name, type.requires_note] as const,
        ),
    ).toEqual([
      ["Banheiro", false],
      ["Descanso", false],
      ["Parada diversa", true],
      ["Refeição", false],
    ]);
  });
});
