import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { ensureDefaultOccurrenceTypes } from "@/shared/delivery/default-occurrence-types";
import { businessDateKey, shiftDateKey } from "@/shared/time/business-day";

import { seedFleetDriver, seedUser } from "./support/fleet-driver-seed";
import { seedJourneyRoute } from "./support/journey-route-seed";

/**
 * Occurrence categories and pauses as types (decisions 14.3 and 14.4)
 * through the real application and a real database: the catalogue's matrix,
 * locks and guards (including two deactivations racing for the last type of a
 * category), the driver's payload split by category, and the journey rule of
 * the pause routes — with tenant and role guards on each.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fe1c0-0000-7000-8000-00000000000a";
const OTHER = "018fe1c0-0000-7000-8000-00000000000b";
const ZONE = "America/Sao_Paulo";

const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload && { payload }),
  });
}

const refusal = (response: {
  statusCode: number;
  json: () => { code?: string };
}) => `${response.statusCode} ${response.json().code}`;

const createPath = (businessId = CARRIER) =>
  `/occurrence-type/create-occurrence-type/${businessId}`;
const updatePath = (typeId: string, businessId = CARRIER) =>
  `/occurrence-type/update-occurrence-type/${typeId}/business/${businessId}`;
const deletePath = (typeId: string, businessId = CARRIER) =>
  `/occurrence-type/delete-occurrence-type/${typeId}/business/${businessId}`;

async function defaultId(
  businessId: string,
  systemKey: string,
): Promise<string> {
  const type = await prisma.occurrenceType.findUniqueOrThrow({
    where: { businessId_system_key: { businessId, system_key: systemKey } },
    select: { id: true },
  });

  return type.id;
}

async function newDriver(
  businessId: string,
  name: string,
): Promise<{ id: string; token: string }> {
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
      businessId,
    },
  });

  const user = await seedUser(prisma, businessId, "BUSINESS_USER", driver.id);

  return { id: driver.id, token: user.token };
}

/** A MASTER session, for the company creation. */
async function masterToken(): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Suporte",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "MASTER",
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
    {
      subject: id,
      expiresIn: "30m",
    },
  );
}

/** Lines of the NDJSON list: the meta first, then one per item. */
async function listLines(query: string, token = tokens.admin) {
  const response = await call(
    "GET",
    `/occurrence-type/list-occurrence-type?page=1&pageSize=50&${query}`,
    token,
  );

  expect(response.statusCode, response.body).toBe(200);

  return response.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

beforeAll(async () => {
  const carrier = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: "11222888000101",
  });
  const other = await seedFleetDriver(prisma, {
    businessId: OTHER,
    cnpj: "11222888000202",
  });

  tokens.admin = carrier.managerToken;
  tokens.driver = carrier.driverToken;
  tokens.otherAdmin = other.managerToken;
  ids.driver = carrier.driverId;

  // What the migration and create-business seed for every company.
  await ensureDefaultOccurrenceTypes(prisma, CARRIER);
  await ensureDefaultOccurrenceTypes(prisma, OTHER);

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("the catalogue with categories", () => {
  it("creates a delivered type and lists it by category, the default marked and in use flagged", async () => {
    const created = await call("POST", createPath(), tokens.admin, {
      name: "Entrega com avaria",
      category: "DELIVERED",
      requires_receipt_photo: true,
      requires_signature: true,
    });

    expect(created.statusCode, created.body).toBe(201);

    const [meta, ...rows] = await listLines(
      "category=DELIVERED&sort=name&order=asc",
    );

    expect(rows.map((row: { name: string }) => row.name)).toEqual([
      "Entrega com avaria",
      "Entrega normal",
    ]);
    expect(rows[1]).toMatchObject({
      is_default: true,
      in_use: false,
      category: "DELIVERED",
      requires_receipt_photo: true,
    });
    expect(rows[0]).toMatchObject({
      is_default: false,
      requires_signature: true,
    });
    // The platform's key never leaves the API.
    expect(
      rows.some((row: Record<string, unknown>) => "system_key" in row),
    ).toBe(false);
    expect(meta.meta.searchMeta.facets.category).toEqual([
      { value: "DELIVERED", count: 2 },
      { value: "NOT_DELIVERED", count: 0 },
      { value: "PAUSE", count: 3 },
    ]);
  });

  it("refuses what the matrix refuses as 400 with sentences, never a 500 from the CHECKs", async () => {
    const noNature = await call("POST", createPath(), tokens.admin, {
      name: "Pausa sem natureza",
      category: "PAUSE",
    });

    expect(refusal(noNature)).toBe("400 VALIDATION_ERROR");
    expect(noNature.json().issues).toEqual([
      "Escolha a natureza legal da pausa (refeição, descanso ou outra).",
    ]);

    const blockingDelivery = await call("POST", createPath(), tokens.admin, {
      name: "Entrega que impede",
      category: "DELIVERED",
      blocks_delivery: true,
    });

    expect(refusal(blockingDelivery)).toBe("400 VALIDATION_ERROR");

    // Editing a pause type into a shape the CHECK refuses (was a 500).
    const pauseWithSignature = await call(
      "PATCH",
      updatePath(await defaultId(CARRIER, "pause_rest")),
      tokens.admin,
      { requires_signature: true },
    );

    expect(refusal(pauseWithSignature)).toBe("400 VALIDATION_ERROR");
  });

  it("keeps a default's category and nature, but lets it be renamed and asked for a signature", async () => {
    const delivered = await defaultId(CARRIER, "delivered_default");

    expect(
      refusal(
        await call("PATCH", updatePath(delivered), tokens.admin, {
          category: "NOT_DELIVERED",
        }),
      ),
    ).toBe("409 OCCURRENCE_TYPE_CATEGORY_LOCKED");

    const edited = await call("PATCH", updatePath(delivered), tokens.admin, {
      name: "Entrega padrão",
      requires_signature: true,
    });

    expect(edited.statusCode, edited.body).toBe(200);
    expect(
      await prisma.occurrenceType.findUniqueOrThrow({
        where: { id: delivered },
      }),
    ).toMatchObject({
      name: "Entrega padrão",
      requires_signature: true,
      system_key: "delivered_default",
    });

    // Back to today's behaviour for the files that follow.
    await call("PATCH", updatePath(delivered), tokens.admin, {
      name: "Entrega normal",
      requires_signature: false,
    });
  });

  it("lets exactly one of two racing deactivations take the last-but-one delivery type", async () => {
    const extra = await call("POST", createPath(), tokens.admin, {
      name: "Entrega no vizinho",
      category: "DELIVERED",
    });

    expect(extra.statusCode).toBe(201);

    const extraId = (
      await prisma.occurrenceType.findFirstOrThrow({
        where: { businessId: CARRIER, name: "Entrega no vizinho" },
      })
    ).id;
    const avariaId = (
      await prisma.occurrenceType.findFirstOrThrow({
        where: { businessId: CARRIER, name: "Entrega com avaria" },
      })
    ).id;

    // Three active: the default stays out of the race.
    const responses = await Promise.all(
      [extraId, avariaId].map((id) =>
        call("PATCH", updatePath(id), tokens.admin, { is_active: false }),
      ),
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 200,
    ]);

    const delivered = await defaultId(CARRIER, "delivered_default");

    expect(
      refusal(
        await call("PATCH", updatePath(delivered), tokens.admin, {
          is_active: false,
        }),
      ),
    ).toBe("409 OCCURRENCE_TYPE_LAST_OF_CATEGORY");

    // Two racing for the last two: exactly one wins.
    await call("PATCH", updatePath(extraId), tokens.admin, { is_active: true });

    const race = await Promise.all(
      [extraId, delivered].map((id) =>
        call("PATCH", updatePath(id), tokens.admin, { is_active: false }),
      ),
    );

    expect(race.map(refusal).sort()).toEqual([
      "200 undefined",
      "409 OCCURRENCE_TYPE_LAST_OF_CATEGORY",
    ]);
    expect(
      await prisma.occurrenceType.count({
        where: { businessId: CARRIER, category: "DELIVERED", is_active: true },
      }),
    ).toBe(1);

    const off = await prisma.occurrenceType.findFirstOrThrow({
      where: {
        businessId: CARRIER,
        category: "DELIVERED",
        is_active: false,
        id: { in: [extraId, delivered] },
      },
    });

    expect(off.deactivated_at).toBeInstanceOf(Date);

    // Everything active again for what follows.
    for (const id of [extraId, delivered]) {
      await call("PATCH", updatePath(id), tokens.admin, { is_active: true });
    }

    expect(
      (
        await prisma.occurrenceType.findUniqueOrThrow({
          where: { id: delivered },
        })
      ).deactivated_at,
    ).toBeNull();
  });

  // Review r1: the update guarded the last active type of a category, the
  // delete did not. Deactivate the default, then delete the other one: the
  // company was left with no way to prove a delivery.
  it("refuses deleting the last active delivery type, as it refuses deactivating it", async () => {
    const delivered = await defaultId(CARRIER, "delivered_default");
    const others = await prisma.occurrenceType.findMany({
      where: {
        businessId: CARRIER,
        category: "DELIVERED",
        is_active: true,
        id: { not: delivered },
      },
      select: { id: true },
    });

    // Only the default and one fresh, unused type stay active.
    await prisma.occurrenceType.updateMany({
      where: { id: { in: others.map((row) => row.id) } },
      data: { is_active: false },
    });

    try {
      const created = await call("POST", createPath(), tokens.admin, {
        name: "Entrega na portaria",
        category: "DELIVERED",
      });

      expect(created.statusCode, created.body).toBe(201);

      const lone = (
        await prisma.occurrenceType.findFirstOrThrow({
          where: { businessId: CARRIER, name: "Entrega na portaria" },
        })
      ).id;

      expect(
        (
          await call("PATCH", updatePath(delivered), tokens.admin, {
            is_active: false,
          })
        ).statusCode,
      ).toBe(200);

      expect(
        refusal(await call("DELETE", deletePath(lone), tokens.admin)),
      ).toBe("409 OCCURRENCE_TYPE_LAST_OF_CATEGORY");
      expect(await prisma.occurrenceType.count({ where: { id: lone } })).toBe(
        1,
      );

      // With another active one, the unused type goes.
      await call("PATCH", updatePath(delivered), tokens.admin, {
        is_active: true,
      });

      expect(
        (await call("DELETE", deletePath(lone), tokens.admin)).statusCode,
      ).toBe(200);
      expect(await prisma.occurrenceType.count({ where: { id: lone } })).toBe(
        0,
      );
    } finally {
      await prisma.occurrenceType.update({
        where: { id: delivered },
        data: { is_active: true, deactivated_at: null },
      });
      await prisma.occurrenceType.updateMany({
        where: { id: { in: others.map((row) => row.id) } },
        data: { is_active: true },
      });
    }
  });

  it("never deletes a default, and refuses a pause type a pause names with 409, not the FK's 500", async () => {
    expect(
      refusal(
        await call(
          "DELETE",
          deletePath(await defaultId(CARRIER, "pause_other")),
          tokens.admin,
        ),
      ),
    ).toBe("409 OCCURRENCE_TYPE_DEFAULT");

    const snack = await call("POST", createPath(), tokens.admin, {
      name: "Lanche",
      category: "PAUSE",
      pause_kind: "REST",
    });

    expect(snack.statusCode).toBe(201);

    const snackId = (
      await prisma.occurrenceType.findFirstOrThrow({
        where: { businessId: CARRIER, name: "Lanche" },
      })
    ).id;
    ids.snack = snackId;

    const walker = await newDriver(CARRIER, "Pausa Lanche");
    await seedJourneyRoute(prisma, CARRIER, walker.id);

    const started = await call(
      "POST",
      `/driver-pause/start/${CARRIER}`,
      walker.token,
      {
        occurrence_type_id: snackId,
        start_submission_id: randomUUID(),
      },
    );

    expect(started.statusCode, started.body).toBe(201);
    expect(started.json().pause).toMatchObject({
      kind: "REST",
      occurrence_type: { id: snackId, name: "Lanche" },
    });

    expect(
      refusal(await call("DELETE", deletePath(snackId), tokens.admin)),
    ).toBe("409 OCCURRENCE_TYPE_IN_USE");

    const [, ...pauses] = await listLines("category=PAUSE");

    expect(
      pauses.find((row: { id: string }) => row.id === snackId),
    ).toMatchObject({
      in_use: true,
      is_default: false,
    });

    expect(
      refusal(
        await call("PATCH", updatePath(snackId), tokens.admin, {
          pause_kind: "MEAL",
        }),
      ),
    ).toBe("409 OCCURRENCE_TYPE_CATEGORY_LOCKED");
  });

  it("answers another company's type like a missing one, and refuses a driver", async () => {
    const delivered = await defaultId(CARRIER, "delivered_default");

    expect(
      refusal(
        await call("PATCH", updatePath(delivered, OTHER), tokens.otherAdmin, {
          name: "Minha",
        }),
      ),
    ).toBe("404 OCCURRENCE_TYPE_NOT_FOUND");
    expect(
      refusal(
        await call("DELETE", deletePath(delivered, OTHER), tokens.otherAdmin),
      ),
    ).toBe("404 OCCURRENCE_TYPE_NOT_FOUND");
    expect(
      (
        await call("POST", createPath(), tokens.driver, {
          name: "Do motorista",
          category: "DELIVERED",
        })
      ).statusCode,
    ).toBe(403);
    // A company's admin on another company's URL is stopped at the tenant guard.
    expect(
      (
        await call("PATCH", updatePath(delivered), tokens.otherAdmin, {
          name: "Minha",
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe("a company created through the API", () => {
  it("is born with the four default types, in the same commit as the company", async () => {
    const token = await masterToken();
    const cnpj = "77333444000155";

    const response = await call("POST", "/business/create-business", token, {
      corporate_reason: "Transportadora Semente",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Carla Souza",
      telephone: "11999999999",
      email: `semente-${randomUUID().slice(0, 6)}@exemplo.com.br`,
    });

    expect(response.statusCode, response.body).toBe(201);

    const business = await prisma.business.findFirstOrThrow({
      where: { cnpj },
    });
    const types = await prisma.occurrenceType.findMany({
      where: { businessId: business.id },
      orderBy: { system_key: "asc" },
      select: {
        system_key: true,
        name: true,
        category: true,
        pause_kind: true,
      },
    });

    expect(types).toEqual([
      {
        system_key: "delivered_default",
        name: "Entrega normal",
        category: "DELIVERED",
        pause_kind: null,
      },
      {
        system_key: "pause_meal",
        name: "Refeição",
        category: "PAUSE",
        pause_kind: "MEAL",
      },
      {
        system_key: "pause_other",
        name: "Outra pausa",
        category: "PAUSE",
        pause_kind: "OTHER",
      },
      {
        system_key: "pause_rest",
        name: "Descanso",
        category: "PAUSE",
        pause_kind: "REST",
      },
    ]);
  });
});

describe("the driver's day payload", () => {
  it("keeps occurrence_types to the not-delivered vocabulary and carries the new keys", async () => {
    await call("POST", createPath(), tokens.admin, {
      name: "Cliente ausente",
      blocks_delivery: true,
    });

    const response = await call(
      "GET",
      `/delivery/my-deliveries/${CARRIER}`,
      tokens.driver,
    );

    expect(response.statusCode, response.body).toBe(200);

    const body = response.json();

    expect(
      body.occurrence_types.map((type: { name: string }) => type.name),
    ).toEqual(["Cliente ausente"]);
    expect(body.occurrence_types[0]).toMatchObject({
      category: "NOT_DELIVERED",
      requires_receipt_photo: false,
      requires_signature: false,
    });
    expect(body.delivered_types[0]).toMatchObject({
      name: "Entrega normal",
      is_default: true,
      category: "DELIVERED",
      requires_receipt_photo: true,
      requires_signature: false,
      form_version: 1,
    });
    expect(body.pause_types.map((type: { name: string }) => type.name)).toEqual(
      ["Descanso", "Lanche", "Outra pausa", "Refeição"],
    );
    // The carrier's main driver has no route: no journey.
    // With the company's day it was judged in: the app trusts a cached
    // answer only while that day lasts (review r1).
    expect(body.journey).toEqual({
      pause_allowed: false,
      route_id: null,
      day: businessDateKey(new Date(), ZONE),
      time_zone: ZONE,
    });
  });

  it("seeds the defaults of a company that never had them", async () => {
    const fresh = await seedFleetDriver(prisma, {
      businessId: "018fe1c0-0000-7000-8000-00000000000c",
      cnpj: "11222888000303",
    });

    const response = await call(
      "GET",
      "/delivery/my-deliveries/018fe1c0-0000-7000-8000-00000000000c",
      fresh.driverToken,
    );

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .delivered_types.map((type: { name: string }) => type.name),
    ).toEqual(["Entrega normal"]);
    expect(response.json().pause_types).toHaveLength(3);
  });
});

describe("a pause only inside a journey", () => {
  const startPath = `/driver-pause/start/${CARRIER}`;
  const endPath = `/driver-pause/end/${CARRIER}`;

  it("refuses a start without a route released or running today, writing nothing", async () => {
    const idle = await newDriver(CARRIER, "Sem Rota");

    const response = await call("POST", startPath, idle.token, {
      kind: "MEAL",
      start_submission_id: randomUUID(),
    });

    expect(refusal(response)).toBe("409 PAUSE_REQUIRES_ROUTE");
    expect(response.json().message).toBe(
      "Pausas só podem ser iniciadas durante uma rota liberada ou em andamento.",
    );
    expect(
      await prisma.driverPause.count({ where: { driverId: idle.id } }),
    ).toBe(0);

    const current = await call(
      "GET",
      `/driver-pause/current/${CARRIER}`,
      idle.token,
    );

    expect(current.json()).toMatchObject({
      pause_allowed: false,
      journey_route_id: null,
    });

    // An end that would create the pause is a start too.
    const end = await call("POST", endPath, idle.token, {
      start_submission_id: randomUUID(),
      end_submission_id: randomUUID(),
      start: { kind: "MEAL" },
    });

    expect(refusal(end)).toBe("409 PAUSE_REQUIRES_ROUTE");
  });

  it("refuses a route released today for tomorrow, and takes one released for today", async () => {
    const planner = await newDriver(CARRIER, "Rota de Amanhã");
    const today = businessDateKey(new Date(), ZONE);

    const tomorrowRoute = await seedJourneyRoute(prisma, CARRIER, planner.id, {
      status: "RELEASED",
      releasedAt: new Date(Date.now() - 60 * 60_000),
      scheduledDate: shiftDateKey(today, 1),
    });

    // The app's offline rule needs the route's day in the cached payload:
    // a RELEASED route counts only on its day (review r1).
    const shipper = await prisma.shipper.create({
      data: { name: "Embarcador amanhã", businessId: CARRIER },
    });
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente de amanhã",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId: shipper.id,
        driverId: planner.id,
        status: "IN_TRANSIT",
      },
    });

    await prisma.routeStop.create({
      data: { routeId: tomorrowRoute, deliveryId: delivery.id, sequence: 10 },
    });

    const day = await call(
      "GET",
      `/delivery/my-deliveries/${CARRIER}`,
      planner.token,
    );
    const card = (day.json().data as Array<Record<string, any>>).find(
      (entry) => entry.id === delivery.id,
    );

    expect(card?.stops[0].route).toMatchObject({
      status: "RELEASED",
      scheduled_date: `${shiftDateKey(today, 1)}T00:00:00.000Z`,
    });
    expect(day.json().journey).toMatchObject({
      pause_allowed: false,
      day: today,
      time_zone: ZONE,
    });

    expect(
      refusal(
        await call("POST", startPath, planner.token, {
          kind: "REST",
          start_submission_id: randomUUID(),
        }),
      ),
    ).toBe("409 PAUSE_REQUIRES_ROUTE");

    const routeId = await seedJourneyRoute(prisma, CARRIER, planner.id, {
      status: "RELEASED",
      releasedAt: new Date(Date.now() - 60 * 60_000),
      scheduledDate: today,
    });

    const started = await call("POST", startPath, planner.token, {
      kind: "REST",
      start_submission_id: randomUUID(),
    });

    expect(started.statusCode, started.body).toBe(201);
    expect(started.json().pause.routeId).toBe(routeId);

    const current = await call(
      "GET",
      `/driver-pause/current/${CARRIER}`,
      planner.token,
    );

    expect(current.json()).toMatchObject({
      pause_allowed: true,
      journey_route_id: routeId,
    });
  });

  it("never refuses ending a pause that exists, even after its route is cancelled", async () => {
    const closer = await newDriver(CARRIER, "Fim sem Rota");
    const routeId = await seedJourneyRoute(prisma, CARRIER, closer.id);
    const key = randomUUID();

    expect(
      (
        await call("POST", startPath, closer.token, {
          kind: "MEAL",
          start_submission_id: key,
        })
      ).statusCode,
    ).toBe(201);

    await prisma.route.update({
      where: { id: routeId },
      data: { status: "CANCELLED", cancellation_reason: "Teste" },
    });

    const ended = await call("POST", endPath, closer.token, {
      start_submission_id: key,
      end_submission_id: randomUUID(),
    });

    expect(ended.statusCode, ended.body).toBe(200);
  });

  it("checks the chosen type: another company's is missing, a delivery type is the wrong category", async () => {
    const chooser = await newDriver(CARRIER, "Escolhe Tipo");
    await seedJourneyRoute(prisma, CARRIER, chooser.id);

    const foreign = await defaultId(OTHER, "pause_meal");
    const delivered = await defaultId(CARRIER, "delivered_default");

    expect(
      refusal(
        await call("POST", startPath, chooser.token, {
          occurrence_type_id: foreign,
          start_submission_id: randomUUID(),
        }),
      ),
    ).toBe("404 OCCURRENCE_TYPE_NOT_FOUND");
    expect(
      refusal(
        await call("POST", startPath, chooser.token, {
          occurrence_type_id: delivered,
          start_submission_id: randomUUID(),
        }),
      ),
    ).toBe("400 OCCURRENCE_TYPE_WRONG_CATEGORY");
    expect(
      refusal(
        await call("POST", startPath, chooser.token, {
          start_submission_id: randomUUID(),
        }),
      ),
    ).toBe("400 VALIDATION_ERROR");
    expect(
      await prisma.driverPause.count({ where: { driverId: chooser.id } }),
    ).toBe(0);
  });

  it("records the installed app's `kind` under the default type of that nature", async () => {
    const legacy = await newDriver(CARRIER, "App Antigo");
    await seedJourneyRoute(prisma, CARRIER, legacy.id);

    const response = await call("POST", startPath, legacy.token, {
      kind: "OTHER",
      start_submission_id: randomUUID(),
    });

    expect(response.statusCode, response.body).toBe(201);

    const row = await prisma.driverPause.findFirstOrThrow({
      where: { driverId: legacy.id },
    });

    expect(row.occurrenceTypeId).toBe(await defaultId(CARRIER, "pause_other"));
    expect(row.kind).toBe("OTHER");
  });
});
