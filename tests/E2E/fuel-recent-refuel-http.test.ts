import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import type { UploadService } from "@/shared/services/upload-service";
import { createPrismaClient } from "@/shared/database/database-client";

import {
  fakeJpeg,
  seedFleetDriver,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { readNdjson } from "./support/fleet-maint-seed";

/**
 * A second refuelling of the same vehicle within 30 minutes, over real HTTP
 * and Postgres (owner, 05/11/2026; 20261105130000).
 *
 * - No cooldown: every refuelling is recorded, and one with another of the
 *   vehicle less than 30 minutes away from its date, either side, carries
 *   RECENT_REFUEL and the other one's date — from the driver, the office,
 *   the offline queue or an older build alike.
 * - A driver on a build that asks (contract 5 on), sending now (no
 *   X-Client-Queued-At) and unconfirmed, is refused with 409
 *   FUEL_RECENT_REFUEL and the other refuelling. Nothing is recorded and the
 *   photo stays in storage: the same body, key and photo resent with
 *   `confirm_recent` and `recent_reason` is recorded with the reason.
 * - A resend of a recorded refuelling is answered with it before the rule.
 * - Two refuellings sent at once: both recorded, one flagged (the
 *   serializable create sees the other).
 * - The list returns the fields, filters by `alerts` and counts the facet;
 *   an edit that moves the date measures it again and keeps the reason.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let uploads: UploadService;
const storedKeys: string[] = [];

const CARRIER = "018fec20-0000-7000-8000-00000000000a";

let carrier: FleetDriverSeed;

const CONTRACT_5 =
  "platform=android; version=1.5.0; build=50; runtime=e2e; update=embedded; contract=5; outbox=1";
const CONTRACT_4 =
  "platform=android; version=1.4.0; build=40; runtime=e2e; update=embedded; contract=4; outbox=1";

const GPS = { latitude: -23.55, longitude: -46.63 };

/**
 * One hour apart per scenario, all in the past and in date order: each
 * refuelling is the vehicle's newest, with the highest km, and no scenario
 * sits inside another's window.
 */
const BASE = Date.now() - 24 * 60 * 60 * 1000;
let scenario = 0;

function nextSlot(): number {
  scenario += 1;

  return BASE + scenario * 60 * 60 * 1000;
}

const at = (slot: number, minutes: number) =>
  new Date(slot + minutes * 60_000).toISOString();

let mileage = 1_000;

async function storedPhoto(): Promise<string> {
  const key = `odometerPhotos/${CARRIER}/${Date.now()}-recent-${randomUUID()}.jpg`;

  await uploads.putObject(key, fakeJpeg(), "image/jpeg");
  storedKeys.push(key);

  return key;
}

/** What the app sends: its key, the GPS point, the moment of the tap. */
async function appBody(
  refuelingDate: string,
  extra: Record<string, unknown> = {},
) {
  mileage += 10;

  return {
    client_submission_id: randomUUID(),
    current_mileage: mileage,
    liters_amount: 50,
    price_per_liter: 6.5,
    refueling_date: refuelingDate,
    businessId: CARRIER,
    vehicleId: carrier.vehicleId,
    fuelTypeId: carrier.fuelTypeId,
    created_from: "MOBILE_APP",
    ...GPS,
    photo: { key: await storedPhoto() },
    ...extra,
  };
}

/** What the web's form sends for a manager (an instant, as the app build). */
async function officeBody(
  refuelingDate: string,
  extra: Record<string, unknown> = {},
) {
  mileage += 10;

  return {
    current_mileage: mileage,
    liters_amount: 50,
    price_per_liter: 6.5,
    refueling_date: refuelingDate,
    businessId: CARRIER,
    vehicleId: carrier.vehicleId,
    driverId: carrier.driverId,
    fuelTypeId: carrier.fuelTypeId,
    branchId: carrier.branchId,
    created_from: "WEB_DASHBOARD",
    photo: { key: await storedPhoto() },
    ...extra,
  };
}

const fuelUrl = `/fuel/create-fuel/${CARRIER}`;

const post = (
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: "POST",
    url: fuelUrl,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: body,
  });

const rowOf = (response: { json: () => { id: string } }) =>
  prisma.fuel.findUniqueOrThrow({ where: { id: response.json().id } });

beforeAll(async () => {
  carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "77888999000202",
    mileage: 1_000,
  });

  ({ app } = await import("@/http"));
  await app.ready();

  uploads = container.resolve<UploadService>("UploadService");
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(storedKeys.map((key) => uploads.deleteFile(key)));
  await app?.close();
  await prisma.$disconnect();
});

describe("a driver on contract 5, sending now", () => {
  it("is refused unconfirmed, with the other one, and recorded when the same body comes back confirmed", async () => {
    const slot = nextSlot();
    const first = await post(carrier.driverToken, await appBody(at(slot, 0)), {
      "x-trajetto-client-version": CONTRACT_5,
    });

    expect(first.statusCode, first.body).toBe(201);
    expect((await rowOf(first)).alerts).toEqual([]);

    const before = await prisma.fuel.count({ where: { businessId: CARRIER } });
    const second = await appBody(at(slot, 19));

    const refused = await post(carrier.driverToken, second, {
      "x-trajetto-client-version": CONTRACT_5,
    });

    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.headers["x-error-code"]).toBe("FUEL_RECENT_REFUEL");
    expect(refused.json()).toEqual({
      code: "FUEL_RECENT_REFUEL",
      message: expect.stringMatching(
        /^Este veículo já tem um abastecimento registrado às \d{2}:\d{2}\. Para registrar outro em menos de 30 minutos, confirme e informe o motivo\.$/,
      ),
      previous_refuel: {
        id: first.json().id,
        refueling_date: at(slot, 0),
        liters_amount: 50,
        current_mileage: mileage - 10,
      },
    });
    expect(await prisma.fuel.count({ where: { businessId: CARRIER } })).toBe(
      before,
    );
    // The photo is still there for the resend.
    expect(
      await uploads.readObject((second.photo as { key: string }).key),
    ).not.toBeNull();

    // A tick without a reason is not a confirmation.
    const tickOnly = await post(
      carrier.driverToken,
      { ...second, confirm_recent: true, recent_reason: "  " },
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(tickOnly.statusCode, tickOnly.body).toBe(409);

    const confirmed = await post(
      carrier.driverToken,
      {
        ...second,
        confirm_recent: true,
        recent_reason: " Tanque na reserva ",
      },
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(confirmed.statusCode, confirmed.body).toBe(201);

    const row = await rowOf(confirmed);

    expect(row).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_reason: "Tanque na reserva",
      recent_refuel_previous_at: new Date(at(slot, 0)),
      client_submission_id: second.client_submission_id,
      odometer_photo: (second.photo as { key: string }).key,
    });

    // The trail says it before the origin (fuel-created-policy).
    const event = await prisma.domainOutboxEvent.findFirstOrThrow({
      where: { aggregateId: row.id, topic: "fuel.created" },
    });

    expect(event.payload).toMatchObject({
      recentRefuelAt: expect.stringMatching(/^\d{2}:\d{2}$/),
      recentRefuelReason: "Tanque na reserva",
    });
  });

  it("is answered with the refuelling already recorded under its key, before the rule", async () => {
    const slot = nextSlot();
    const headers = { "x-trajetto-client-version": CONTRACT_5 };

    await post(carrier.driverToken, await appBody(at(slot, 0)), headers);

    const body = await appBody(at(slot, 10), {
      confirm_recent: true,
      recent_reason: "Completei o tanque",
    });
    const recorded = await post(carrier.driverToken, body, headers);

    expect(recorded.statusCode, recorded.body).toBe(201);

    // The same submission resent without the answer: the record, not 409.
    const resend = await post(
      carrier.driverToken,
      { ...body, confirm_recent: undefined, recent_reason: undefined },
      headers,
    );

    expect(resend.statusCode, resend.body).toBe(201);
    expect(resend.json().id).toBe(recorded.json().id);
  });
});

describe("recorded and flagged, never refused", () => {
  it("from the offline queue (X-Client-Queued-At), without a reason", async () => {
    const slot = nextSlot();

    await post(carrier.driverToken, await appBody(at(slot, 0)), {
      "x-trajetto-client-version": CONTRACT_5,
    });

    const queued = await post(
      carrier.driverToken,
      await appBody(at(slot, 12)),
      {
        "x-trajetto-client-version": CONTRACT_5,
        "x-client-queued-at": at(slot, 12),
      },
    );

    expect(queued.statusCode, queued.body).toBe(201);
    expect(await rowOf(queued)).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_reason: null,
      recent_refuel_previous_at: new Date(at(slot, 0)),
    });
  });

  it("from a build of contract 4, and from one that sends no header (mobile main)", async () => {
    for (const headers of [
      { "x-trajetto-client-version": CONTRACT_4 },
      {} as Record<string, string>,
    ]) {
      const slot = nextSlot();

      await post(carrier.driverToken, await appBody(at(slot, 0)), headers);

      const second = await post(
        carrier.driverToken,
        await appBody(at(slot, 5)),
        headers,
      );

      expect(second.statusCode, second.body).toBe(201);
      expect((await rowOf(second)).alerts).toEqual(["RECENT_REFUEL"]);
    }
  });

  it("from the office, whatever the build", async () => {
    const slot = nextSlot();

    await post(carrier.managerToken, await officeBody(at(slot, 0)));

    const second = await post(
      carrier.managerToken,
      await officeBody(at(slot, 20)),
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(second.statusCode, second.body).toBe(201);
    expect(await rowOf(second)).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_reason: null,
    });
  });

  it("by its own date, when the other one is LATER (a late delivery of the queue)", async () => {
    const slot = nextSlot();

    // Recorded first, at :20; the queued one was tapped at :05 with a
    // lower km, and lands between the readings around its date.
    mileage += 100;
    const laterKm = mileage;
    const later = await post(carrier.driverToken, {
      ...(await appBody(at(slot, 20))),
      current_mileage: laterKm,
    });

    expect(later.statusCode, later.body).toBe(201);

    const late = await post(
      carrier.driverToken,
      { ...(await appBody(at(slot, 5))), current_mileage: laterKm - 50 },
      {
        "x-trajetto-client-version": CONTRACT_5,
        "x-client-queued-at": at(slot, 5),
      },
    );

    expect(late.statusCode, late.body).toBe(201);
    expect(await rowOf(late)).toMatchObject({
      alerts: ["RECENT_REFUEL"],
      recent_refuel_previous_at: new Date(at(slot, 20)),
    });
  });

  it("two sent at once: both recorded, one of them flagged", async () => {
    const slot = nextSlot();
    const [a, b] = [
      await officeBody(at(slot, 0)),
      await officeBody(at(slot, 3)),
    ];

    const [first, second] = await Promise.all([
      post(carrier.managerToken, a),
      post(carrier.managerToken, b),
    ]);

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);

    const flagged = [await rowOf(first), await rowOf(second)].filter((row) =>
      row.alerts.includes("RECENT_REFUEL"),
    );

    expect(flagged).toHaveLength(1);
  });

  it("not 30 minutes or more apart", async () => {
    const slot = nextSlot();

    await post(carrier.driverToken, await appBody(at(slot, 0)), {
      "x-trajetto-client-version": CONTRACT_5,
    });

    const apart = await post(carrier.driverToken, await appBody(at(slot, 30)), {
      "x-trajetto-client-version": CONTRACT_5,
    });

    expect(apart.statusCode, apart.body).toBe(201);
    expect(await rowOf(apart)).toMatchObject({
      alerts: [],
      recent_refuel_previous_at: null,
    });
  });
});

describe("what the office reads", () => {
  interface Row {
    id: string;
    alerts: string[];
    recent_refuel_reason: string | null;
    recent_refuel_previous_at: string | null;
  }

  interface Meta {
    total: number;
    searchMeta: {
      facets: { alerts: Array<{ value: string; count: number }> };
    };
  }

  it("lists the fields, filters by `alerts` and counts the facet", async () => {
    const flaggedRows = await prisma.fuel.count({
      where: { businessId: CARRIER, alerts: { has: "RECENT_REFUEL" } },
    });

    expect(flaggedRows).toBeGreaterThan(0);

    const all = await readNdjson<Row, Meta>(
      app,
      "/fuel/list-fuel?page=1&pageSize=100",
      carrier.managerToken,
    );

    expect(all.status, all.body).toBe(200);
    expect(all.rows.every((row) => Array.isArray(row.alerts))).toBe(true);
    expect(all.meta.searchMeta.facets.alerts).toEqual([
      { value: "RECENT_REFUEL", count: flaggedRows },
    ]);

    const flagged = await readNdjson<Row, Meta>(
      app,
      "/fuel/list-fuel?page=1&pageSize=100&alerts=RECENT_REFUEL",
      carrier.managerToken,
    );

    expect(flagged.meta.total).toBe(flaggedRows);
    expect(
      flagged.rows.every((row) => row.alerts.includes("RECENT_REFUEL")),
    ).toBe(true);
    expect(
      flagged.rows.find((row) => row.recent_refuel_reason !== null),
    ).toMatchObject({
      recent_refuel_reason: expect.any(String),
      recent_refuel_previous_at: expect.any(String),
    });

    // A value outside the enum is a 400, like every closed facet.
    const wrong = await readNdjson(
      app,
      "/fuel/list-fuel?page=1&pageSize=100&alerts=LATE",
      carrier.managerToken,
    );

    expect(wrong.status).toBe(400);

    const exported = await app.inject({
      method: "GET",
      url: "/fuel/export-fuel?format=csv&alerts=RECENT_REFUEL",
      headers: { authorization: `Bearer ${carrier.managerToken}` },
    });

    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain("Alertas");
    expect(exported.body).toContain("Motivo Informado");
    expect(exported.body).toContain(
      "Outro abastecimento do veículo em menos de 30 min",
    );
  });

  it("an edit that moves the date measures it again, keeping the reason", async () => {
    const slot = nextSlot();

    await post(carrier.driverToken, await appBody(at(slot, 0)), {
      "x-trajetto-client-version": CONTRACT_5,
    });

    const confirmed = await post(
      carrier.driverToken,
      await appBody(at(slot, 10), {
        confirm_recent: true,
        recent_reason: "Tanque na reserva",
      }),
      { "x-trajetto-client-version": CONTRACT_5 },
    );

    expect(confirmed.statusCode, confirmed.body).toBe(201);

    const id = confirmed.json().id;
    const moved = await app.inject({
      method: "PATCH",
      url: `/fuel/update-fuel/${id}/business/${CARRIER}`,
      headers: { authorization: `Bearer ${carrier.managerToken}` },
      payload: { refueling_date: at(slot, 40) },
    });

    expect(moved.statusCode, moved.body).toBe(200);
    expect(
      await prisma.fuel.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      alerts: [],
      recent_refuel_previous_at: null,
      recent_refuel_reason: "Tanque na reserva",
    });
  });
});
