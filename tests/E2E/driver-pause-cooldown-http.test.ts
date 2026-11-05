import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@/shared/database/database-client";

import { seedFleetDriver, seedUser } from "./support/fleet-driver-seed";
import { seedJourneyRoute } from "./support/journey-route-seed";

/**
 * The 5 minutes between pauses, over real HTTP and Postgres (owner,
 * 05/11/2026; no migration).
 *
 * - A NEW start tapped less than 5 minutes (minus 30 s of slack) after the
 *   driver's previous pause ended is refused with 409 PAUSE_COOLDOWN and
 *   nothing is written — only from a build that holds the wait (contract 5
 *   on, in x-trajetto-client-version) sending now (no X-Client-Queued-At).
 *   The body says when the previous pause ended, when the next may start
 *   and how many seconds that is from the server's now.
 * - The offline queue's start, a build without the header (the web, mobile
 *   `main`) and contract 4 are recorded.
 * - A resend of a start that got in is answered with it, even inside the
 *   cooldown; an end — even one that creates the pause already closed — is
 *   never refused.
 * - Another driver's pause never counts.
 * - GET /driver-pause/current says the same three things.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe1e5-0000-7000-8000-00000000000a";

const CONTRACT_5 =
  "platform=android; version=1.5.0; build=50; runtime=e2e; update=embedded; contract=5; outbox=1";
const CONTRACT_4 =
  "platform=android; version=1.4.0; build=40; runtime=e2e; update=embedded; contract=4; outbox=1";

const MINUTE = 60_000;

const startPath = `/driver-pause/start/${CARRIER}`;
const endPath = `/driver-pause/end/${CARRIER}`;
const currentPath = `/driver-pause/current/${CARRIER}`;

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

function get(path: string, token: string) {
  return app.inject({
    method: "GET",
    url: path,
    headers: { authorization: `Bearer ${token}` },
  });
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

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

/**
 * A pause of the driver, started and ended by the app: the start tapped
 * `startedAgo` ms ago, the end `endedAgo` ms ago (or now). Sent with no
 * contract header, so the cooldown never gets in the way of the setup.
 */
async function takePause(
  token: string,
  {
    startedAgo = 20 * MINUTE,
    endedAgo,
  }: { startedAgo?: number; endedAgo?: number } = {},
) {
  const startKey = randomUUID();

  const started = await post(startPath, token, {
    kind: "REST",
    start_submission_id: startKey,
    occurred_at: ago(startedAgo),
  });

  expect(started.statusCode, started.body).toBe(201);

  const ended = await post(endPath, token, {
    start_submission_id: startKey,
    end_submission_id: randomUUID(),
    ...(endedAgo !== undefined && { occurred_at: ago(endedAgo) }),
  });

  expect(ended.statusCode, ended.body).toBe(200);

  return {
    startKey,
    pause: ended.json().pause as { id: string; ended_at: string },
  };
}

const pausesOf = (driverId: string) =>
  prisma.driverPause.count({ where: { driverId } });

beforeAll(async () => {
  await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "11222555000105",
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a new start from contract 5, sent now", () => {
  it("is refused right after an end, with when the next may start, and nothing is written", async () => {
    const driver = await newDriver("Pausa Seguida");
    const { pause } = await takePause(driver.token);

    const refused = await post(
      startPath,
      driver.token,
      { kind: "MEAL", start_submission_id: randomUUID() },
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.headers["x-error-code"]).toBe("PAUSE_COOLDOWN");

    const body = refused.json();
    const allowedAt = new Date(pause.ended_at).getTime() + 5 * MINUTE;

    expect(body).toEqual({
      code: "PAUSE_COOLDOWN",
      message: expect.stringMatching(
        /^Você encerrou uma pausa às \d{2}:\d{2}\. Uma nova pausa fica disponível às \d{2}:\d{2}\.$/,
      ),
      last_ended_at: pause.ended_at,
      next_pause_allowed_at: new Date(allowedAt).toISOString(),
      next_pause_in_seconds: expect.any(Number),
    });
    expect(body.next_pause_in_seconds).toBeGreaterThan(240);
    expect(body.next_pause_in_seconds).toBeLessThanOrEqual(300);
    expect(await pausesOf(driver.id)).toBe(1);
  });

  it("is taken once 5 minutes passed since the end", async () => {
    const driver = await newDriver("Pausa Depois");

    await takePause(driver.token, { endedAgo: 6 * MINUTE });

    const taken = await post(
      startPath,
      driver.token,
      { kind: "MEAL", start_submission_id: randomUUID() },
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(taken.statusCode, taken.body).toBe(201);
  });

  it("is refused for a tap 4 minutes after the end, and the clock's correction applies", async () => {
    const driver = await newDriver("Pausa Corrigida");

    await takePause(driver.token, { endedAgo: 10 * MINUTE });

    // The phone is two hours ahead; its tap, 6 minutes ago by its own
    // clock, is 4 minutes after the end on the server's.
    const phoneNow = Date.now() + 2 * 60 * MINUTE;
    const refused = await post(
      startPath,
      driver.token,
      {
        kind: "MEAL",
        start_submission_id: randomUUID(),
        occurred_at: new Date(phoneNow - 6 * MINUTE).toISOString(),
      },
      {
        "x-trajetto-client-version": CONTRACT_5,
        "x-client-sent-at": new Date(phoneNow).toISOString(),
      },
    );

    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("PAUSE_COOLDOWN");
    // Measured from now: the wait is over, the tap still was inside it.
    expect(refused.json().next_pause_in_seconds).toBe(0);
  });
});

describe("a start recorded inside the cooldown", () => {
  it("from the offline queue (X-Client-Queued-At)", async () => {
    const driver = await newDriver("Pausa da Fila");

    await takePause(driver.token);

    const queued = await post(
      startPath,
      driver.token,
      { kind: "MEAL", start_submission_id: randomUUID() },
      {
        "x-trajetto-client-version": CONTRACT_5,
        "x-client-queued-at": new Date().toISOString(),
      },
    );

    expect(queued.statusCode, queued.body).toBe(201);
    expect(await pausesOf(driver.id)).toBe(2);
  });

  it("from a build without the header, and from contract 4", async () => {
    for (const headers of [
      {},
      { "x-trajetto-client-version": CONTRACT_4 },
    ] as Array<Record<string, string>>) {
      const driver = await newDriver("Pausa Antiga");

      await takePause(driver.token);

      const taken = await post(
        startPath,
        driver.token,
        { kind: "MEAL", start_submission_id: randomUUID() },
        headers,
      );

      expect(taken.statusCode, taken.body).toBe(201);
    }
  });

  it("never because of another driver's pause", async () => {
    const first = await newDriver("Pausa Um");
    const second = await newDriver("Pausa Dois");

    await takePause(first.token);

    const taken = await post(
      startPath,
      second.token,
      { kind: "MEAL", start_submission_id: randomUUID() },
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(taken.statusCode, taken.body).toBe(201);
  });
});

describe("what the cooldown never refuses", () => {
  it("the resend of a start that got in, sent now from contract 5", async () => {
    const driver = await newDriver("Pausa Reenviada");
    const { startKey, pause } = await takePause(driver.token, {
      startedAgo: 10 * MINUTE,
      endedAgo: MINUTE,
    });

    const resent = await post(
      startPath,
      driver.token,
      { kind: "REST", start_submission_id: startKey },
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(resent.statusCode, resent.body).toBe(200);
    expect(resent.json()).toMatchObject({
      replayed: true,
      pause: { id: pause.id },
    });
  });

  it("an end, even one that creates the pause closed, and the late start then finds it", async () => {
    const driver = await newDriver("Fim Primeiro");

    await takePause(driver.token, { endedAgo: 3 * MINUTE });

    const lateStart = randomUUID();
    const ended = await post(
      endPath,
      driver.token,
      {
        start_submission_id: lateStart,
        end_submission_id: randomUUID(),
        occurred_at: ago(30_000),
        start: { kind: "REST", occurred_at: ago(2 * MINUTE) },
      },
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json().replayed).toBe(false);

    const started = await post(
      startPath,
      driver.token,
      {
        kind: "REST",
        start_submission_id: lateStart,
        occurred_at: ago(2 * MINUTE),
      },
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({
      replayed: true,
      pause: { id: ended.json().pause.id },
    });
  });
});

describe("GET /driver-pause/current", () => {
  it("says nothing to wait for before the first ended pause", async () => {
    const driver = await newDriver("Sem Pausa");
    const current = await get(currentPath, driver.token);

    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({
      last_ended_at: null,
      next_pause_allowed_at: null,
      next_pause_in_seconds: 0,
    });
  });

  it("says when the next pause may start, and how many seconds that is", async () => {
    const driver = await newDriver("Com Pausa");
    const { pause } = await takePause(driver.token);

    const current = (await get(currentPath, driver.token)).json();
    const allowedAt = new Date(pause.ended_at).getTime() + 5 * MINUTE;

    expect(current.last_ended_at).toBe(pause.ended_at);
    expect(current.next_pause_allowed_at).toBe(
      new Date(allowedAt).toISOString(),
    );
    expect(current.next_pause_in_seconds).toBeGreaterThan(240);
    expect(current.next_pause_in_seconds).toBeLessThanOrEqual(300);
  });

  it("answers 0 once the wait is over", async () => {
    const driver = await newDriver("Pausa Antiga Hoje");

    await takePause(driver.token, { endedAgo: 6 * MINUTE });

    expect((await get(currentPath, driver.token)).json()).toMatchObject({
      next_pause_in_seconds: 0,
    });
  });
});
