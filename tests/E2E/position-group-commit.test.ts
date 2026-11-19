import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The GPS group commit through the whole stack (plano-escala F5-19), with
 * POSITION_GROUP_COMMIT=on.
 *
 * Fifty POST /route/positions at once, from five drivers of five
 * companies, as the fleet sends them: the acceptance is at most ten
 * commits for the fifty, and every point of a request already in the
 * database when its 200 arrives. The commits are counted by Postgres
 * itself: the rows one transaction inserts share its xmin, so the
 * distinct xmins of the trail are the transactions that wrote it. A batch
 * that failed and went flush by flush would show as many.
 */
// Before any import: the env is parsed once, when `@/env` first loads, and
// the seed helper loads it through `@/config/auth`.
vi.hoisted(() => {
  process.env.POSITION_GROUP_COMMIT = "on";
});

const prisma = createPrismaClient();

const DRIVERS = 5;
const POSTS_PER_DRIVER = 10;
const POINTS_PER_POST = 3;

let app: Awaited<typeof import("@/http")>["app"];

const seeds: Array<{ driverId: string; token: string }> = [];

beforeAll(async () => {
  for (let index = 0; index < DRIVERS; index += 1) {
    const businessId = `018fe0c2-0000-7000-8000-00000000000${index}`;
    const seed = await seedFleetDriver(prisma, {
      businessId,
      cnpj: String(
        60000000000000 + index * 10_000_000 + Math.floor(Math.random() * 9e6),
      ),
    });

    await prisma.route.create({
      data: {
        code: 1,
        status: "IN_PROGRESS",
        scheduled_date: new Date(),
        started_at: new Date(Date.now() - 60 * 60_000),
        businessId,
        driverId: seed.driverId,
        vehicleId: seed.vehicleId,
      },
    });

    seeds.push({ driverId: seed.driverId, token: seed.driverToken });
  }

  ({ app } = await import("@/http"));
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("fifty flushes at once with the group commit on", () => {
  it("commit in at most ten transactions, each point stored before its 200", async () => {
    const start = Date.now() - 30 * 60_000;
    const missingAtAnswer: string[] = [];

    const posts = seeds.flatMap(({ driverId, token }) =>
      Array.from({ length: POSTS_PER_DRIVER }, (_, post) => {
        const instants = Array.from(
          { length: POINTS_PER_POST },
          (_, point) =>
            new Date(start + (post * POINTS_PER_POST + point) * 1000),
        );

        return app
          .inject({
            method: "POST",
            url: "/route/positions",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              pings: instants.map((at, point) => ({
                latitude: -23.55 + point * 0.0001,
                longitude: -46.63,
                accuracy: 10,
                recorded_at: at.toISOString(),
              })),
            },
          })
          .then(async (response) => {
            // The answer is out: its points must already be committed.
            const found = await prisma.driverPosition.count({
              where: { driverId, recorded_at: { in: instants } },
            });

            if (found !== POINTS_PER_POST) {
              missingAtAnswer.push(`${driverId}#${post}: ${found}`);
            }

            return response;
          });
      }),
    );

    const responses = await Promise.all(posts);

    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toMatchObject({
        stored: POINTS_PER_POST,
        rejected: 0,
        tracking: true,
      });
    }

    expect(missingAtAnswer).toEqual([]);

    const driverIds = seeds.map((seed) => seed.driverId);

    expect(
      await prisma.driverPosition.count({
        where: { driverId: { in: driverIds } },
      }),
    ).toBe(DRIVERS * POSTS_PER_DRIVER * POINTS_PER_POST);

    const [{ commits }] = await prisma.$queryRaw<Array<{ commits: number }>>`
      SELECT count(DISTINCT xmin::text)::int AS "commits"
      FROM "driver_position_v2"
      WHERE "driverId"::text = ANY(${driverIds}::text[])
    `;

    expect(commits).toBeGreaterThanOrEqual(1);
    expect(commits).toBeLessThanOrEqual(10);

    // Each driver's map moved to its newest point, as without the batch.
    const last = await prisma.driverLastPosition.findMany({
      where: { driverId: { in: driverIds } },
      select: { recorded_at: true },
    });

    expect(last.map((row) => row.recorded_at.getTime())).toEqual(
      driverIds.map(
        () => start + (POSTS_PER_DRIVER * POINTS_PER_POST - 1) * 1000,
      ),
    );
  }, 60_000);
});
