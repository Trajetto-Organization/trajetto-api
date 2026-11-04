import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import {
  seedFleetDriver,
  seedUser,
  type FleetDriverSeed,
} from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The zone the tower's Ocorrências, Auditoria and Atendimentos tabs print in
 * (plan of 02/11/2026, H6; decision D22; scenarios S16 and S20), over real
 * HTTP and Postgres.
 *
 * The three tabs printed their hours on the browser's clock while the route
 * detail, the Painel and Rotas used the company's: the same occurrence read
 * different hours between a tab and the route detail for anyone outside the
 * zone. Each list now answers the company's zone beside its rows — in the
 * NDJSON meta line's `searchMeta` for the two streamed lists (as the routes
 * list does), in `meta` for the tickets' JSON. A field the response schema
 * does not declare is dropped by the serializer, which is why this goes
 * through the wire.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const MANAUS = randomUUID();
const DEFAULT_ZONE = randomUUID();

let manaus: FleetDriverSeed;
let defaultZone: FleetDriverSeed;

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** The NDJSON stream's first line. */
function metaLine(body: string): { searchMeta?: { timeZone?: string } } {
  return JSON.parse(body.split("\n")[0]).meta;
}

beforeAll(async () => {
  manaus = await seedFleetDriver(prisma, {
    businessId: MANAUS,
    cnpj: "44555666000191",
  });
  defaultZone = await seedFleetDriver(prisma, {
    businessId: DEFAULT_ZONE,
    cnpj: "44555666000272",
  });

  await prisma.business.update({
    where: { id: MANAUS },
    data: { timezone: "America/Manaus" },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("the tower's tabs answer the company's zone", () => {
  it("Ocorrências: in the meta line", async () => {
    const response = await get(
      "/delivery/list-occurrences?page=1&pageSize=10",
      manaus.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(metaLine(response.body).searchMeta?.timeZone).toBe("America/Manaus");
  });

  it("Auditoria: in the meta line", async () => {
    const response = await get(
      "/delivery/proof-audits?status=PENDING&page=1&pageSize=10",
      manaus.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(metaLine(response.body).searchMeta?.timeZone).toBe("America/Manaus");
  });

  it("Atendimentos: in meta, through the response schema", async () => {
    const response = await get(
      "/chat/tickets?status=OPEN&scope=ALL&page=1&pageSize=20",
      manaus.managerToken,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().meta).toEqual({ timeZone: "America/Manaus" });
  });

  it("each company its own: the default zone for one that never set it", async () => {
    // A second manager of the same company sees the same zone; another
    // company sees its own, never the first one's.
    const colleague = await seedUser(prisma, MANAUS, "BUSINESS_ADMIN");

    const [own, other] = await Promise.all([
      get(
        "/chat/tickets?status=OPEN&scope=ALL&page=1&pageSize=20",
        colleague.token,
      ),
      get(
        "/chat/tickets?status=OPEN&scope=ALL&page=1&pageSize=20",
        defaultZone.managerToken,
      ),
    ]);

    expect(own.json().meta).toEqual({ timeZone: "America/Manaus" });
    expect(other.json().meta).toEqual({ timeZone: "America/Sao_Paulo" });

    const occurrences = await get(
      "/delivery/list-occurrences?page=1&pageSize=10",
      defaultZone.managerToken,
    );

    expect(metaLine(occurrences.body).searchMeta?.timeZone).toBe(
      "America/Sao_Paulo",
    );
  });
});

/**
 * The delivery detail dialog (`GET /delivery/get-delivery`, read by the
 * web's lib/delivery-reads) prints the opt-out dates of contract C2 on the
 * same clock: `meta.timeZone` beside `data`, through the response schema.
 */
describe("the delivery detail answers the company's zone", () => {
  async function seededDelivery(seed: FleetDriverSeed): Promise<string> {
    const shipper = await prisma.shipper.create({
      data: {
        name: `Embarcador ${randomUUID().slice(0, 6)}`,
        businessId: seed.businessId,
      },
      select: { id: true },
    });

    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: `Cliente ${randomUUID().slice(0, 6)}`,
        city: "São Paulo",
        uf: "SP",
        street: "Rua das Entregas",
        businessId: seed.businessId,
        shipperId: shipper.id,
        driverId: seed.driverId,
      },
      select: { id: true },
    });

    return delivery.id;
  }

  it("in meta, for the manager and for the driver, each company its own", async () => {
    const [inManaus, inDefault] = await Promise.all([
      seededDelivery(manaus),
      seededDelivery(defaultZone),
    ]);

    const detail = (seed: FleetDriverSeed, id: string, token: string) =>
      get(`/delivery/get-delivery/${id}/business/${seed.businessId}`, token);

    const manager = await detail(manaus, inManaus, manaus.managerToken);

    expect(manager.statusCode, manager.body).toBe(200);
    expect(manager.json().data.id).toBe(inManaus);
    expect(manager.json().meta).toEqual({ timeZone: "America/Manaus" });

    const driver = await detail(manaus, inManaus, manaus.driverToken);

    expect(driver.statusCode, driver.body).toBe(200);
    expect(driver.json().meta).toEqual({ timeZone: "America/Manaus" });

    const other = await detail(
      defaultZone,
      inDefault,
      defaultZone.managerToken,
    );

    expect(other.statusCode, other.body).toBe(200);
    expect(other.json().meta).toEqual({ timeZone: "America/Sao_Paulo" });
  });

  it("a refused read carries no zone: another company's delivery is 404", async () => {
    const inDefault = await seededDelivery(defaultZone);

    const response = await get(
      `/delivery/get-delivery/${inDefault}/business/${MANAUS}`,
      manaus.managerToken,
    );

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe("DELIVERY_NOT_FOUND");
    expect(response.json().meta).toBeUndefined();
  });
});
