import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DashboardRepository } from "@/modules/dashboard/repositories/dashboard-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { GetDashboardTrendsUseCase } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-usecase";

/**
 * The trend chart, and the three hundred queries it used to cost.
 *
 * The overview was fixed months ago: 72 sequential counts became one grouped
 * union, after a first attempt that issued nine in parallel and made the p95
 * of the whole API fifteen times worse by holding nine connections per page
 * view. The trends endpoint next door was left exactly as it was — a loop over
 * every bucket of the window, nine counts in parallel inside it, plus one
 * cost query per bucket.
 *
 * For "30d" that is 30 × 9 + 30 = 300 round trips to draw one chart, and the
 * parallelism is the same mistake in a worse place: nine concurrent
 * connections, thirty times over, per request.
 *
 * Two things are asserted here and both are necessary. That the numbers are
 * right — a fast wrong chart is worse than a slow right one. And that the
 * query COUNT collapsed, because nothing else in the suite would notice if
 * somebody reintroduced the loop: every number would still be correct.
 */
const prisma = new PrismaClient();

/** A second client, with query logging on, so the queries can be counted. */
const counted = new PrismaClient({
  log: [{ level: "query", emit: "event" }],
});

const CARRIER = "018fd300-0000-7000-8000-00000000000a";
const MANAGER = "018fd300-0000-7000-8000-0000000000a1";
const SHIPPER = "018fd300-0000-7000-8000-0000000000f1";

let profileId = "";

let queries = 0;

/** Local wall-clock moment, as the naive instant the column stores. */
function at(daysAgo: number, hour = 12): Date {
  const date = new Date();

  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);

  return date;
}

async function runTrends(period: "7d" | "30d" | "6m"): Promise<any> {
  const useCase = new GetDashboardTrendsUseCase(
    new UserRepository(),
    new DashboardRepository(counted),
  );

  queries = 0;

  return useCase.execute({ userId: MANAGER, period });
}

beforeAll(async () => {
  counted.$on("query" as never, () => {
    queries += 1;
  });

  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Tendências",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(80000000000000 + Math.floor(Math.random() * 9000000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `tendencia-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: CARRIER, module: "DELIVERIES", enabled: true },
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Gestão",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: true,
            businessId: CARRIER,
          },
          {
            permissionKey: "vehicle_manage",
            action: "Gerenciar veículos",
            canRead: true,
            canWrite: true,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  profileId = profile.id;

  await prisma.user.create({
    data: {
      id: MANAGER,
      name: "Gestora",
      email: `gestora-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: profile.id,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
  });

  /**
   * Different counts on different days, on purpose: a chart where every
   * bucket holds the same number cannot tell a correct grouping from one that
   * files everything under the same key.
   *
   * Two of these rows exist to catch specific failures rather than to make a
   * pretty curve:
   *
   * - one TODAY, because the window's last bucket is today and an end
   *   boundary at midnight silently drops the day people are looking at;
   * - one at 22:00 three days ago, which is 01:00 the NEXT day in UTC. The
   *   column holds a UTC instant in a session that runs in UTC, so a
   *   `date_trunc` that skips the conversion back to local files it under the
   *   wrong day. Every row at noon is immune to that mistake, which is why
   *   noon alone proved nothing.
   */
  const moments: Array<[daysAgo: number, hour: number]> = [
    [0, 12],
    [1, 12],
    [1, 12],
    [1, 12],
    [2, 12],
    [3, 22],
    [5, 12],
  ];

  await prisma.delivery.createMany({
    data: moments.map(([daysAgo, hour], index) => ({
      businessId: CARRIER,
      shipperId: SHIPPER,
      code: `TR${index}`,
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "PENDING" as const,
      created_at: at(daysAgo, hour),
    })),
  });
}, 180_000);

afterAll(async () => {
  await prisma.delivery.deleteMany({ where: { businessId: CARRIER } });
  await prisma.shipper.deleteMany({ where: { id: SHIPPER } });

  await prisma.user.deleteMany({ where: { id: MANAGER } });
  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: CARRIER },
  });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
  await counted.$disconnect();
});

describe("how much the chart costs", () => {
  it("draws thirty days in a handful of queries, not three hundred", async () => {
    await runTrends("30d");

    /**
     * One union covers every entity of every day; the costs would be a
     * second, and this profile cannot read them. Two is the ceiling.
     *
     * Deliberately tight. A loose ceiling like "under ten" passes for the
     * loop-per-ENTITY shape as well as the grouped one, and that shape is
     * half of what was wrong here — the original code was a loop over buckets
     * whose body was nine parallel queries, so both dimensions have to be
     * pinned. `does not get more expensive as the window grows` pins the
     * other one.
     */
    expect(queries).toBeLessThanOrEqual(2);
  });

  it("does not get more expensive as the number of entities grows", async () => {
    // Eleven entities are asked for, and they cost what one costs. A loop
    // per entity would answer eleven here and still draw the right chart.
    await runTrends("30d");

    expect(queries).toBeLessThanOrEqual(2);
  });

  it("does not get more expensive as the window grows", async () => {
    await runTrends("7d");
    const short = queries;

    await runTrends("6m");
    const long = queries;

    // The old shape charged per bucket, so a longer window cost strictly
    // more. Grouped, the window is a WHERE clause.
    expect(long).toBe(short);
  });
});

describe("and whether it is still right", () => {
  it("puts each day's deliveries in its own bucket", async () => {
    const trends = await runTrends("30d");

    const points = trends.activityTrends;

    // 30 days back through today, inclusive.
    expect(points).toHaveLength(30);

    const label = (daysAgo: number) =>
      at(daysAgo).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
      });

    const bucketFor = (daysAgo: number) =>
      points.find((point: any) => point.date === label(daysAgo));

    expect(bucketFor(1)?.deliveries).toBe(3);
    expect(bucketFor(2)?.deliveries).toBe(1);
    expect(bucketFor(5)?.deliveries).toBe(1);

    // Today, the window's last bucket. An end boundary at midnight drops it.
    expect(bucketFor(0)?.deliveries, "o último dia sumiu da janela").toBe(1);

    /**
     * 22:00 local, which is 01:00 the next day in UTC.
     *
     * If the grouping truncates the stored instant without reading it back
     * into local time, this row lands one bucket to the right: day 3 reads
     * zero and day 2 reads two. The two assertions together are what makes
     * the timezone conversion testable at all.
     */
    expect(bucketFor(3)?.deliveries, "o fim da noite caiu no dia seguinte").toBe(
      1,
    );

    // A day with nothing is zero and present, not missing: the chart draws a
    // point for it either way.
    expect(bucketFor(4)?.deliveries).toBe(0);
  });

  it("answers zero rather than nothing for an entity with no rows", async () => {
    const trends = await runTrends("30d");

    for (const point of trends.activityTrends) {
      /**
       * `fines` and `parts` are the load-bearing ones: this profile holds
       * neither permission, so they are filtered OUT of the query. They must
       * still appear on the point as zero, because the chart draws a line for
       * every series and `undefined` renders as a gap, not as nothing.
       *
       * Asserting on `vehicles` alone proved nothing — that permission IS
       * granted, so the key is present whether or not hidden entities are
       * filled in.
       */
      expect(point.fines, "uma série sem permissão sumiu do ponto").toBe(0);
      expect(point.parts).toBe(0);

      expect(point.vehicles, "um ponto sem número vira NaN no gráfico").toBe(0);
      expect(typeof point.routes).toBe("number");
    }
  });

  it("collapses the same rows into months when the window is long", async () => {
    const trends = await runTrends("6m");

    const total = trends.activityTrends.reduce(
      (sum: number, point: any) => sum + point.deliveries,
      0,
    );

    // The same seven deliveries, regrouped. A month chart that lost rows at
    // the edge of the window is the classic off-by-one here: the final bucket
    // is the CURRENT month, and it has to include the whole of it.
    expect(total).toBe(7);
  });
});
