import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import auth from "@/config/auth";
import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import { fanOutWebhookEvent } from "@/shared/integration/webhook-dispatch-service";
import type { TestInboxMailProvider } from "@/shared/providers/mail-provider/implementations/test-inbox-mail-provider";

/**
 * The scheduled purge of a company, over real HTTP and Postgres
 * (plano-escala F3-25; the security review of the plan):
 *
 *  - only a MASTER schedules, typing the corporate name; another role is
 *    refused (403), a company that does not exist is 404;
 *  - scheduling blocks the company at once — its panel and its app answer
 *    403, its sessions end, its webhooks stop — enqueues TENANT_OFFBOARD
 *    for purge_after (TENANT_PURGE_AFTER_DAYS later), and mails its
 *    administrators;
 *  - reactivating in SCHEDULED gives everything back, the job cancelled;
 *    in PURGING it is refused with its own code, never half undone;
 *  - a company that was only deactivated (an unpaid bill) is never
 *    scheduled by itself, cannot be "reactivated" from a purge it does not
 *    have, and keeps its plain toggle; a scheduled one refuses the toggle;
 *  - the reminder goes 7 days before, once.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fd400-0000-7000-8000-00000000000a";
const RUNNING = "018fd400-0000-7000-8000-00000000000b";
const OLD_INACTIVE = "018fd400-0000-7000-8000-00000000000c";
const REMINDED = "018fd400-0000-7000-8000-00000000000d";
const MISSING = "018fd400-0000-7000-8000-0000000000ff";

let masterToken: string;
let adminToken: string;
let adminId: string;

let cnpjSeq = 0;

async function seedBusiness(
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-2)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(11222777000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      ...extra,
    },
  });
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN",
  businessId: string | null,
): Promise<{ id: string; token: string }> {
  const id = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${id.slice(0, 4)}`,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
    },
  });

  return { id, token: await sessionOf(id) };
}

/** A fresh session (refresh family) of the user, and its access token. */
async function sessionOf(userId: string): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "15m" },
  );
}

const schedule = (
  businessId: string,
  confirmation: string,
  token = masterToken,
) =>
  app.inject({
    method: "POST",
    url: `/business/schedule-business-purge/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { confirmation },
  });

const cancel = (businessId: string, token = masterToken) =>
  app.inject({
    method: "POST",
    url: `/business/cancel-business-purge/${businessId}`,
    headers: { authorization: `Bearer ${token}` },
  });

const toggle = (businessId: string) =>
  app.inject({
    method: "PATCH",
    url: `/business/toggle-business-active/${businessId}`,
    headers: { authorization: `Bearer ${masterToken}` },
  });

/** A panel read of the company's own: what its users do every minute. */
const panel = (token: string) =>
  app.inject({
    method: "GET",
    url: "/user/me",
    headers: { authorization: `Bearer ${token}` },
  });

const inbox = () =>
  container.resolve<TestInboxMailProvider>("MailProvider").messages();

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(RUNNING);
  await seedBusiness(OLD_INACTIVE, { is_active: false });
  await seedBusiness(REMINDED);

  masterToken = (await seedUser("MASTER", null)).token;

  const admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  adminToken = admin.token;
  adminId = admin.id;

  await seedUser("BUSINESS_ADMIN", REMINDED);

  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhooks",
      secret: "whsec_teste",
      topics: ["delivery.*"],
      businessId: CARRIER,
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("scheduling a company's purge", () => {
  it("is a MASTER's act on a company that exists, confirmed by its name", async () => {
    expect(
      (await schedule(CARRIER, "Transportadora 0a", adminToken)).statusCode,
    ).toBe(403);
    expect((await schedule(MISSING, "Qualquer")).json()).toMatchObject({
      code: "BUSINESS_NOT_FOUND",
    });

    const wrong = await schedule(CARRIER, "Outra empresa");

    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("BUSINESS_PURGE_CONFIRMATION_MISMATCH");

    // Nothing moved.
    expect(
      await prisma.business.findUniqueOrThrow({ where: { id: CARRIER } }),
    ).toMatchObject({ is_active: true, purge_state: null });
  });

  it("blocks the company at once, enqueues the purge for its day and tells the administrators", async () => {
    expect((await panel(adminToken)).statusCode).toBe(200);

    const before = Date.now();
    const response = await schedule(CARRIER, "Transportadora 0a");

    expect(response.statusCode, response.body).toBe(200);

    const { data } = response.json();
    const purgeAfter = new Date(data.purge_after).getTime();

    expect(data).toMatchObject({
      id: CARRIER,
      is_active: false,
      purge_state: "SCHEDULED",
    });
    expect(purgeAfter - before).toBeGreaterThanOrEqual(
      env.TENANT_PURGE_AFTER_DAYS * 86_400_000 - 1_000,
    );

    // The panel (and the app, the same API) answers 403 from now on, and
    // the sessions are gone.
    expect((await panel(adminToken)).statusCode).toBe(403);
    expect(
      await prisma.refreshToken.count({ where: { userId: adminId } }),
    ).toBe(0);

    // The purge waits for its day.
    const job = await prisma.backgroundJob.findFirstOrThrow({
      where: { kind: "TENANT_OFFBOARD", subjectId: CARRIER },
    });

    expect(job).toMatchObject({ status: "PENDING", businessId: CARRIER });
    expect(job.availableAt.getTime()).toBe(purgeAfter);

    // No more webhooks from it.
    expect(
      await fanOutWebhookEvent({
        topic: "delivery.created",
        businessId: CARRIER,
        payload: { delivery_id: randomUUID() },
      }),
    ).toBe(0);

    await vi.waitFor(() =>
      expect(
        inbox().some(
          (message) =>
            message.subject.includes("Transportadora 0a") &&
            message.subject.includes("foi desativada"),
        ),
      ).toBe(true),
    );

    // A second click is refused, not scheduled twice.
    const again = await schedule(CARRIER, "Transportadora 0a");

    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("BUSINESS_PURGE_ALREADY_SCHEDULED");
  });

  it("is not undone by the plain toggle, which would leave it to be purged active", async () => {
    const response = await toggle(CARRIER);

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("BUSINESS_PURGE_SCHEDULED");
  });

  it("shows on the MASTER's list with its dates", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/business/list-business?page=1&pageSize=50",
      headers: { authorization: `Bearer ${masterToken}` },
    });
    const rows = response.body
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line));
    const scheduled = rows.find((row) => row.id === CARRIER);
    const plain = rows.find((row) => row.id === OLD_INACTIVE);

    expect(scheduled).toMatchObject({
      purge_state: "SCHEDULED",
      deactivated_at: expect.any(String),
      purge_after: expect.any(String),
    });
    expect(plain).toMatchObject({
      is_active: false,
      purge_state: null,
      deactivated_at: null,
      purge_after: null,
    });
  });

  it("is cancelled by the reactivation while scheduled, everything back", async () => {
    const response = await cancel(CARRIER);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      is_active: true,
      purge_state: null,
      deactivated_at: null,
      purge_after: null,
    });

    expect(
      await prisma.backgroundJob.findFirstOrThrow({
        where: { kind: "TENANT_OFFBOARD", subjectId: CARRIER },
        select: { status: true },
      }),
    ).toEqual({ status: "CANCELLED" });

    // Its people sign in again.
    adminToken = await sessionOf(adminId);
    expect((await panel(adminToken)).statusCode).toBe(200);

    // Nothing to cancel any more.
    expect((await cancel(CARRIER)).json().code).toBe(
      "BUSINESS_PURGE_NOT_SCHEDULED",
    );
  });

  it("refuses the reactivation once the purge started", async () => {
    expect((await schedule(RUNNING, "Transportadora 0b")).statusCode).toBe(200);

    // The TENANT_OFFBOARD job moved it on under the company's lock (F3-26a).
    await prisma.business.update({
      where: { id: RUNNING },
      data: { purge_state: "PURGING" },
    });

    const response = await cancel(RUNNING);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "BUSINESS_PURGE_RUNNING",
      message:
        "A exclusão desta empresa já começou e não pode mais ser desfeita.",
    });
    expect(
      await prisma.business.findUniqueOrThrow({ where: { id: RUNNING } }),
    ).toMatchObject({ is_active: false, purge_state: "PURGING" });
  });

  it("never schedules a company that was only deactivated", async () => {
    // An unpaid bill of before: inactive, never scheduled, no purge job.
    expect(
      await prisma.business.findUniqueOrThrow({ where: { id: OLD_INACTIVE } }),
    ).toMatchObject({ is_active: false, purge_state: null, purge_after: null });
    expect(
      await prisma.backgroundJob.count({
        where: { kind: "TENANT_OFFBOARD", subjectId: OLD_INACTIVE },
      }),
    ).toBe(0);

    expect((await cancel(OLD_INACTIVE)).json().code).toBe(
      "BUSINESS_PURGE_NOT_SCHEDULED",
    );

    // Its way back is the plain toggle, as before.
    const toggled = await toggle(OLD_INACTIVE);

    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().is_active).toBe(true);
  });

  it("reminds the administrators 7 days before, once", async () => {
    const now = Date.now();

    await prisma.business.update({
      where: { id: REMINDED },
      data: {
        is_active: false,
        purge_state: "SCHEDULED",
        deactivated_at: new Date(now - 23 * 86_400_000),
        purge_after: new Date(now + 6.5 * 86_400_000),
      },
    });

    const { remindBusinessPurgeJob } =
      await import("@/jobs/cron/remind-business-purge-job");
    const reminders = () =>
      inbox().filter(
        (message) =>
          message.subject.includes("Transportadora 0d") &&
          message.subject.includes("serão apagados"),
      ).length;

    await remindBusinessPurgeJob.handler({ scheduledFor: new Date(now) });
    expect(reminders()).toBe(1);

    // The next day's run: out of its window.
    await remindBusinessPurgeJob.handler({
      scheduledFor: new Date(now + 86_400_000),
    });
    expect(reminders()).toBe(1);
  });
});
