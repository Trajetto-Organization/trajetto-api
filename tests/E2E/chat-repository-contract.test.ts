import { afterAll, beforeAll, describe } from "vitest";

import { ChatRepository } from "@/modules/chat/repositories/chat-repository";
import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";
import { CHAT_MESSAGE_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import {
  CHAT_DRIVERS,
  CHAT_FIXTURE as F,
  CHAT_MESSAGES,
  CHAT_READS,
  CHAT_ROUTES,
  CHAT_STOPS,
  CHAT_THREADS,
  CHAT_USERS,
  chatRepositoryContract,
  type ChatHarness,
} from "../contract/repositories/chat.contract";
import { KINDS, type Kind } from "../contract/support";
import {
  seedBranch,
  seedBusiness,
  seedDriver,
  seedShipper,
  seedUser,
} from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/** Decision 13.2: the chat contract against Postgres and the twin. */
const prisma = createPrismaClient();
const prismaRepo = new ChatRepository(prisma);
const memory = new InMemoryChatRepository();

const harnesses: Record<Kind, ChatHarness> = {
  prisma: { kind: "prisma", repo: prismaRepo },
  "in-memory": { kind: "in-memory", repo: memory },
};

async function seedPostgres(): Promise<void> {
  await seedBusiness(prisma, F.A, 1);
  await seedBusiness(prisma, F.B, 2);

  const branch = await seedBranch(prisma, F.A, 1, F.branchOff);
  await prisma.branch.update({
    where: { id: branch.id },
    data: { is_active: false },
  });

  for (const [n, driver] of CHAT_DRIVERS.entries()) {
    await seedDriver(prisma, driver.businessId, n + 1, {
      id: driver.id,
      name: driver.name,
      status: driver.status,
      ...(driver.branchOff && { branchId: F.branchOff }),
    });
  }

  for (const [n, user] of CHAT_USERS.entries()) {
    await seedUser(prisma, user.businessId, n + 1, {
      id: user.id,
      name: user.name,
      driverId: user.driverId,
      access_revoked: user.revoked,
    });
  }

  await prisma.chatThread.createMany({ data: [...CHAT_THREADS] });
  await prisma.chatMessage.createMany({
    data: CHAT_MESSAGES.map((message) => ({
      ...message,
      kind: "TEXT" as const,
    })),
  });
  await prisma.chatThreadRead.createMany({ data: [...CHAT_READS] });

  await seedShipper(prisma, F.A, "Embarcador Chat", F.shipperA);
  await prisma.delivery.create({
    data: {
      id: F.dl1,
      businessId: F.A,
      shipperId: F.shipperA,
      recipient_name: "Cliente do chat",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Entregas",
    },
  });

  for (const route of CHAT_ROUTES) {
    await prisma.route.create({
      data: { ...route, scheduled_date: new Date("2026-09-01T00:00:00.000Z") },
    });
  }

  await prisma.routeStop.createMany({ data: [...CHAT_STOPS] });
}

function seedTwin(): void {
  for (const driver of CHAT_DRIVERS) {
    memory.driverDirectory.set(driver.id, {
      name: driver.name,
      cnh: "",
      businessId: driver.businessId,
      status: driver.status,
      branch: driver.branchOff ? { is_active: false } : null,
    });
  }

  for (const user of CHAT_USERS) {
    memory.userDirectory.set(user.id, {
      name: user.name,
      driverId: user.driverId,
      last_seen_at: null,
      access_revoked: user.revoked,
      businessId: user.businessId,
    });
  }

  memory.threads.push(
    ...CHAT_THREADS.map((thread) => ({
      ...thread,
      driver_delivered_at: null,
      staff_delivered_at: null,
    })),
  );
  memory.messages.push(
    ...CHAT_MESSAGES.map((message) => ({
      ...CHAT_MESSAGE_COLUMN_DEFAULTS,
      ...message,
      kind: "TEXT" as const,
      attachment_key: null,
      duration_ms: null,
      deliveryId: null,
      broadcast_id: null,
    })),
  );
  memory.reads.push(...CHAT_READS.map((read) => ({ ...read })));
  memory.routes.push(...CHAT_ROUTES.map((route) => ({ ...route })));
  memory.routeStops.push(...CHAT_STOPS.map((stop) => ({ ...stop })));
  memory.deliveryDirectory.set(F.dl1, {
    recipient_name: "Cliente do chat",
    status: "PENDING",
  });
}

beforeAll(async () => {
  await seedPostgres();
  seedTwin();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("chat repository (%s)", (kind) => {
  chatRepositoryContract(() => harnesses[kind]);
});
