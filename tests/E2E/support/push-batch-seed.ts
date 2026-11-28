import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import type { Behaviour, ProviderCall } from "./fake-provider";
import type { ResilienceSeed } from "./resilience-seed";

/**
 * The push batch E2E files' world (plano-escala U-06): drivers of one
 * carrier with one to three phones each (iPhones among them), a route
 * released to each, and a fake Expo that records which ticket id it gave
 * to which (delivery, phone), with ids that carry no order.
 */
interface PushDriver {
  userId: string;
  tokens: string[];
}

interface PushMessage {
  to: string;
  tag?: string;
  collapseId?: string;
  data: { deliveryId: string };
}

async function seedPushDrivers(
  prisma: PrismaClient,
  seed: ResilienceSeed,
  count: number,
): Promise<PushDriver[]> {
  const drivers: PushDriver[] = [];

  for (let index = 0; index < count; index += 1) {
    const userId = randomUUID();

    await prisma.user.create({
      data: {
        id: userId,
        name: `Motorista ${index}`,
        email: `motorista-lote-${userId}@exemplo.com.br`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: seed.businessId,
      },
    });

    const tokens: string[] = [];

    for (let device = 0; device < (index % 3) + 1; device += 1) {
      const token = `ExponentPushToken[${userId}-${device}]`;

      await prisma.pushDeviceToken.create({
        data: {
          userId,
          token,
          platform: device === 0 && index % 4 === 0 ? "ios" : "android",
        },
      });

      tokens.push(token);
    }

    drivers.push({ userId, tokens });
  }

  return drivers;
}

/** A route released to each driver: one push row each (route.released). */
async function publishReleasesTo(
  prisma: PrismaClient,
  seed: ResilienceSeed,
  driverUserIds: string[],
): Promise<void> {
  for (const [index, driverUserId] of driverUserIds.entries()) {
    const routeId = randomUUID();

    await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `route.released:${routeId}`,
        topic: "route.released",
        aggregateType: "route",
        aggregateId: routeId,
        businessId: seed.businessId,
        actorId: seed.adminId,
        payload: {
          routeId,
          businessId: seed.businessId,
          driverUserId,
          code: 2000 + index,
          routeName: null,
          stopCount: 3,
          scheduledLabel: "hoje",
        },
      },
    });
  }
}

/**
 * A fake Expo that answers each message with a random ticket id, recorded
 * under `${deliveryId}|${token}` (or an error for the tokens in `dead`).
 * `delayMs` holds the answer like a slow Expo.
 */
function expoLedger(dead: ReadonlySet<string> = new Set()) {
  const given = new Map<string, string>();

  const behaviour =
    (delayMs = 0) =>
    (call: ProviderCall): Behaviour => {
      const messages = (Array.isArray(call.body) ? call.body : []) as
        PushMessage[] | [];

      return {
        kind: "status",
        status: 200,
        delayMs,
        body: {
          data: messages.map((message) => {
            if (dead.has(message.to)) {
              return {
                status: "error",
                message: "not registered",
                details: { error: "DeviceNotRegistered" },
              };
            }

            const id = randomUUID();

            given.set(`${message.data.deliveryId}|${message.to}`, id);

            return { status: "ok", id };
          }),
        },
      };
    };

  return { given, behaviour };
}

/** Every message the fake Expo received, over every call. */
function pushMessagesOf(calls: ProviderCall[]): PushMessage[] {
  return calls.flatMap((call) =>
    Array.isArray(call.body) ? (call.body as PushMessage[]) : [],
  );
}

/** The expo tickets the receipts ledger holds, as `delivery|token|id`. */
async function ledgerTickets(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.notificationProviderReceipt.findMany({
    where: { provider: "expo", status: "ticket" },
  });

  return rows
    .map((row) => `${row.deliveryId}|${row.pushToken}|${row.providerMessageId}`)
    .sort();
}

export {
  expoLedger,
  ledgerTickets,
  publishReleasesTo,
  pushMessagesOf,
  seedPushDrivers,
};
export type { PushDriver, PushMessage };
