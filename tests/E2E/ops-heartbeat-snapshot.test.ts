import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * OBS-03: what the ops heartbeat reads from the database, against a real one.
 * The rules are unit-tested; this proves the SQL behind them runs, reads what
 * it claims, and that a stuck outbox event and an expired WhatsApp token
 * each turn into a reason the external check receives.
 */
const prisma = new PrismaClient();

const BUSINESS = "018fc000-0000-7000-8000-000000000fa1";
const USER = "018fc000-0000-7000-8000-000000000fa2";

let outboxEventId: string;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora do Alerta",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000968",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `alerta-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa do Alerta",
      email: `alerta-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  // Due ten minutes ago and never taken: an expansion worker that stopped.
  const stuck = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `ops-heartbeat:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      payload: {},
      status: "PENDING",
      availableAt: new Date(Date.now() - 10 * 60 * 1000),
    },
  });

  outboxEventId = stuck.id;

  // A published event whose WhatsApp failed a minute ago on an expired token.
  const published = await prisma.domainOutboxEvent.create({
    data: {
      eventKey: `ops-heartbeat:${randomUUID()}`,
      topic: "account-payable.created",
      aggregateType: "account-payable",
      aggregateId: randomUUID(),
      businessId: BUSINESS,
      payload: {},
      status: "PUBLISHED",
    },
  });

  await prisma.notificationDelivery.create({
    data: {
      outboxEventId: published.id,
      userId: USER,
      channel: "WHATSAPP",
      status: "FAILED",
      attempts: 1,
      lastError: "[whatsapp http=401 code=190] Session has expired",
    },
  });
}, 60_000);

afterAll(async () => {
  await prisma.domainOutboxEvent.deleteMany({
    where: { businessId: BUSINESS },
  });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });
  await prisma.$disconnect();
}, 60_000);

describe("the operational snapshot", () => {
  it("reads every part of the check without error", async () => {
    const { collectOperationalSnapshot } = await import(
      "@/shared/health/operational-snapshot"
    );

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.collectionErrors).toEqual([]);
    expect(snapshot.connectionUsagePercent).toBeGreaterThan(0);
    expect(snapshot.redisOk).toBe(true);
  });

  it("measures the stuck outbox event from when it became due", async () => {
    const { collectOperationalSnapshot } = await import(
      "@/shared/health/operational-snapshot"
    );

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.outboxEligibleLagSec).toBeGreaterThanOrEqual(590);
  });

  it("sees the recent credential failure and turns both into reasons", async () => {
    const { collectOperationalSnapshot } = await import(
      "@/shared/health/operational-snapshot"
    );
    const { evaluateAlerts } = await import("@/shared/health/alert-rules");

    const snapshot = await collectOperationalSnapshot();

    expect(snapshot.deliveryFailures).toContainEqual({
      channel: "WHATSAPP",
      lastError: "[whatsapp http=401 code=190] Session has expired",
    });

    const reasons = evaluateAlerts(snapshot);

    expect(reasons.some((reason) => /outbox/i.test(reason))).toBe(true);
    expect(reasons.some((reason) => reason.includes("code=190"))).toBe(true);
  });

  it("stops paging for the outbox once the event is taken", async () => {
    await prisma.domainOutboxEvent.update({
      where: { id: outboxEventId },
      data: { status: "PUBLISHED", processedAt: new Date() },
    });

    const { collectOperationalSnapshot } = await import(
      "@/shared/health/operational-snapshot"
    );

    const snapshot = await collectOperationalSnapshot();

    // Another file's event may be due at this instant; ours is not.
    expect(snapshot.outboxEligibleLagSec ?? 0).toBeLessThan(590);
  });
});
