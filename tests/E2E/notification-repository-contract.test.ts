import { afterAll, beforeAll, describe } from "vitest";

import { NotificationRepository } from "@/modules/notification/repositories/notification-repository";
import { InMemoryNotificationRepository } from "@/modules/notification/repositories/in-memory/in-memory-notification-repository";

import {
  NOTIFICATION_FIXTURE as F,
  NOTIFICATION_SEED,
  notificationRepositoryContract,
  type NotificationHarness,
} from "../contract/repositories/notification.contract";
import { KINDS, minute, type Kind } from "../contract/support";
import { seedBusiness, seedUser } from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Decision 13.2: the notification contract against Postgres and the twin. */
const prisma = createPrismaClient();
const prismaRepo = new NotificationRepository(prisma);
const memory = new InMemoryNotificationRepository();

const ids: Partial<Record<Kind, Map<string, string>>> = {};

const harnessOf = (kind: Kind): NotificationHarness => ({
  kind,
  repo: kind === "prisma" ? prismaRepo : memory,
  id: (key) => {
    const id = ids[kind]?.get(key);
    if (!id) throw new Error(`no notification ${key}`);
    return id;
  },
});

const harnesses: Record<Kind, NotificationHarness> = {
  prisma: harnessOf("prisma"),
  "in-memory": harnessOf("in-memory"),
};

beforeAll(async () => {
  await seedBusiness(prisma, F.A, 1);
  await seedUser(prisma, F.A, 1, { id: F.userA });
  await seedUser(prisma, F.A, 2, { id: F.userB });

  for (const kind of KINDS) {
    const repo = harnesses[kind].repo;
    const created = new Map<string, string>();

    for (const row of NOTIFICATION_SEED) {
      const notification = await repo.createNotification({
        userId: row.userId,
        type: "system",
        title: `Aviso ${row.key}`,
        message: "Mensagem",
        businessId: F.A,
      });

      created.set(row.key, notification.id);

      if (kind === "prisma") {
        await prisma.notification.update({
          where: { id: notification.id },
          data: { created_at: minute(row.minute), read: row.read ?? false },
        });
      } else {
        const stored = memory.notifications.find(
          (entry) => entry.id === notification.id,
        )!;
        stored.created_at = minute(row.minute);
        stored.read = row.read ?? false;
      }
    }

    ids[kind] = created;
  }
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("notification repository (%s)", (kind) => {
  notificationRepositoryContract(() => harnesses[kind]);
});
