import "reflect-metadata";

import type { Prisma } from "@prisma/client";

import { ReleaseRouteUseCase } from "@/modules/route/usecases/release-route/release-route-usecase";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryWebhookFanOutService } from "@/shared/integration/in-memory/in-memory-webhook-fan-out-service";

import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

/**
 * Run in a child process by route-release-label.test.ts with TZ set: a
 * vitest worker cannot change its own zone, and the defect it guards only
 * shows west of UTC. Releases a route of the 17th through the REAL use case
 * and prints the day label the driver's push carries.
 */
async function main(): Promise<void> {
  const routes = new InMemoryRouteRepository();
  const published: Array<{ payload: Record<string, unknown> }> = [];

  const outbox = {
    publish: async (
      _tx: unknown,
      event: { payload: Record<string, unknown> },
    ) => {
      published.push(event);
    },
  } as unknown as OutboxService;

  const useCase = new ReleaseRouteUseCase(
    routes,
    new InMemoryUserRepository(),
    new InMemoryDriverRepository(),
    {
      createActivityIfEnabled: async () => undefined,
    } as unknown as NotificationService,
    outbox,
    new InMemoryWebhookFanOutService().asService(),
  );

  const route = await routes.createRoute({
    businessId: "business",
    driverId: "driver",
    vehicleId: "vehicle",
    scheduled_date: new Date("2026-09-17T00:00:00.000Z"),
    deliveryIds: [],
  });

  await useCase.transitionWithin({} as Prisma.TransactionClient, {
    userId: "dispatcher",
    businessId: "business",
    route,
    released: true,
  });

  process.stdout.write(
    JSON.stringify({
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      label: published[0]?.payload.scheduledLabel ?? null,
    }),
  );

  // Module-level clients (Prisma, Redis) may keep handles open.
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});
