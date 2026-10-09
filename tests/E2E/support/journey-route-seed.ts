import type { PrismaClient, RouteStatus } from "@prisma/client";

import { businessDateKey, dateOnlyFromKey } from "@/shared/time/business-day";

/**
 * A route that makes a journey for the driver (decision 14.4): pauses only
 * start while the driver has a route RELEASED or IN_PROGRESS that day. For
 * tests about something else that start pauses through the real routes.
 * Defaults to a route on the street for 40 days: older than any pause
 * report range (31 days plus 2), so it never shows up in a report test.
 */
async function seedJourneyRoute(
  prisma: PrismaClient,
  businessId: string,
  driverId: string,
  options: {
    status?: Extract<RouteStatus, "RELEASED" | "IN_PROGRESS">;
    releasedAt?: Date;
    startedAt?: Date | null;
    /** "YYYY-MM-DD"; defaults to today in São Paulo. */
    scheduledDate?: string;
  } = {},
): Promise<string> {
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const status = options.status ?? "IN_PROGRESS";

  const last = await prisma.route.aggregate({ where: { businessId }, _max: { code: true } });

  const route = await prisma.route.create({
    data: {
      // A range of its own: tests number their routes by hand from 1.
      code: Math.max((last._max.code ?? 0) + 1, 70_000),
      name: "Jornada de teste",
      businessId,
      driverId,
      status,
      scheduled_date: dateOnlyFromKey(
        options.scheduledDate ?? businessDateKey(new Date(), "America/Sao_Paulo"),
      ),
      released_at: options.releasedAt ?? longAgo,
      started_at:
        options.startedAt !== undefined
          ? options.startedAt
          : status === "IN_PROGRESS"
            ? new Date(longAgo.getTime() + 60_000)
            : null,
    },
    select: { id: true },
  });

  return route.id;
}

export { seedJourneyRoute };
