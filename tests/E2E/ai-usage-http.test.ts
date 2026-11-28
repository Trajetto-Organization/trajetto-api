import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";
import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { env } from "@/env";
import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { getOrCreateCurrentPeriod } from "@/shared/ai/ai-quota-service";
import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { buildProofAnalysisInput } from "@/shared/delivery/proof-analysis-input";
import { shiftMonthKey } from "@/shared/time/business-day";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The AI quota as the limits card reads it (AI-10, AI-15), over HTTP.
 *
 * The card said "abastecimentos e checklists" and "verificações", while the
 * receipts spent the same quota and every unit is a photo; the month was the
 * UTC month, reset at 21:00 in Brasília, and the "last reset" came back as a
 * date-only value the browser showed as "31/08 21:00".
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

// Manaus (UTC-4), so the zone is visibly the company's and not São Paulo's.
const CARRIER = "018fdcc0-0000-7000-8000-00000000000a";
const OTHER = "018fdcc0-0000-7000-8000-00000000000b";

let adminToken = "";
let otherAdminToken = "";
let clerkToken = "";
let masterToken = "";
let periodId = "";

async function session(
  businessId: string | null,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  // A business user with a working profile, so the refusal is the route's
  // role gate and not a session without permissions.
  const profileAccessId =
    role === "BUSINESS_USER" && businessId
      ? (
          await prisma.profileAccess.create({
            data: {
              name: `Perfil ${id.slice(0, 8)}`,
              businessId,
              permissions: {
                create: [
                  {
                    permissionKey: "fuel_manage",
                    action: "fuel_manage",
                    canRead: true,
                    canWrite: true,
                    businessId,
                  },
                ],
              },
            },
          })
        ).id
      : null;

  await prisma.user.create({
    data: {
      id,
      name: "Gestora",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    {
      subject: id,
      expiresIn: "15m",
    },
  );
}

async function seedBusiness(id: string, cnpj: string) {
  await prisma.business.create({
    data: {
      id,
      // The whole id: the name is unique (business_corporate_reason_key), and
      // company() below seeds random ids. Their last character alone collided
      // with each other and with CARRIER/OTHER in about half of the runs.
      corporate_reason: `Transportadora ${id}`,
      cep: "69000000",
      city: "Manaus",
      uf: "AM",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "92999999999",
      email: `${id}@exemplo.com.br`,
      timezone: "America/Manaus",
      ai_analysis_limit: 100,
    },
  });
}

/** One request of `type` whose units were read (`consumed`) this period. */
async function readPhotos(
  businessId: string,
  type: "FUEL_ODOMETER" | "CHECKLIST" | "DELIVERY_PROOF",
  consumed: number,
  consumedAt = new Date(),
) {
  const request = await prisma.aIAnalysisRequest.create({
    data: {
      idempotencyKey: randomUUID(),
      type,
      recordId: randomUUID(),
      businessId,
      periodId,
      requestedById: randomUUID(),
      input: {},
      status: "COMPLETED",
    },
  });

  await prisma.aIAnalysisUnit.createMany({
    data: Array.from({ length: consumed }, (_, n) => ({
      requestId: request.id,
      unitKey: `unit-${n}`,
      status: "CONSUMED" as const,
      consumedAt,
    })),
  });

  await prisma.aIUsagePeriod.update({
    where: { id: periodId },
    data: { consumedUnits: { increment: consumed } },
  });
}

beforeAll(async () => {
  await seedBusiness(CARRIER, "62777777000190");
  await seedBusiness(OTHER, "62777777000271");

  adminToken = await session(CARRIER, "BUSINESS_ADMIN");
  otherAdminToken = await session(OTHER, "BUSINESS_ADMIN");
  clerkToken = await session(CARRIER, "BUSINESS_USER");
  masterToken = await session(null, "MASTER");

  periodId = (await getOrCreateCurrentPeriod(prisma as never, CARRIER)).id;

  await readPhotos(CARRIER, "FUEL_ODOMETER", 2);
  await readPhotos(CARRIER, "CHECKLIST", 5);
  await readPhotos(CARRIER, "DELIVERY_PROOF", 3);

  // Read last month by a request revived into this one: charged to last
  // month's ledger, so not this month's photos.
  await readPhotos(
    CARRIER,
    "CHECKLIST",
    4,
    new Date(
      quotaPeriodFor(new Date(), "America/Manaus").startsAt.getTime() - 60_000,
    ),
  );
  await prisma.aIUsagePeriod.update({
    where: { id: periodId },
    data: { consumedUnits: { decrement: 4 } },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("GET /business/get-ai-usage", () => {
  it("counts photos by what they were, in the company's month", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/business/get-ai-usage/${CARRIER}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode, response.body).toBe(200);

    const data = response.json().data;

    expect(data.ai_analysis_used).toBe(10);
    expect(data.ai_analysis_used_by_type).toEqual({
      fuel: 2,
      checklist: 5,
      proof: 3,
    });
  });

  it("says when the month began and when it resets, at midnight in the company's zone", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/business/get-ai-usage/${CARRIER}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const data = response.json().data;
    const period = quotaPeriodFor(new Date(), "America/Manaus");

    expect(data.ai_analysis_timezone).toBe("America/Manaus");

    // ISO 8601 on the wire, as documented. Red before: the Date went through
    // z.coerce.string() and came out as "Thu Oct 01 2026 04:00:00 GMT+0000 (...)".
    expect(data.ai_analysis_reset_at).toBe(period.startsAt.toISOString());
    expect(data.ai_analysis_next_reset_at).toBe(period.resetAt.toISOString());

    // 04:00 UTC is midnight in Manaus.
    expect(new Date(data.ai_analysis_next_reset_at).getUTCHours()).toBe(4);
  });

  it("does not show one company's usage to another's admin", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/business/get-ai-usage/${CARRIER}`,
      headers: { authorization: `Bearer ${otherAdminToken}` },
    });

    // The platform's tenant guard answers first, as on every route that
    // names a company in its path.
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
    expect(response.body).not.toContain("ai_analysis_used_by_type");
  });

  // Red before: a bare 400 with no code, told apart from a malformed id by
  // nothing (decision 11.3).
  it("answers a company that does not exist with 404 and its code", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: `/business/get-ai-usage/${randomUUID()}`,
      headers: { authorization: `Bearer ${masterToken}` },
    });

    expect(unknown.statusCode, unknown.body).toBe(404);
    expect(unknown.json().code).toBe("BUSINESS_NOT_FOUND");
  });

  it("lets the MASTER read any company's usage", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/business/get-ai-usage/${CARRIER}`,
      headers: { authorization: `Bearer ${masterToken}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.ai_analysis_used).toBe(10);
  });

  it("is refused to a business user of the same company", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/business/get-ai-usage/${CARRIER}`,
      headers: { authorization: `Bearer ${clerkToken}` },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("AUTH_ROLE_FORBIDDEN");
    expect(response.body).not.toContain("ai_analysis_used_by_type");
  });

  it("publishes every refusal it can answer", () => {
    const document = app.swagger() as unknown as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };

    const route = document.paths["/business/get-ai-usage/{businessId}"].get;

    expect(Object.keys(route.responses)).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404", "429"]),
    );
  });
});

/**
 * The AI limit end to end (plan M7): the cases the owner asked to see
 * proven — a limit lowered in the middle of the month, 0 switching the AI
 * off, and the month turning at midnight in the company's own zone.
 */
describe("the AI limit across a month (M7)", () => {
  const saved = {
    provider: env.AI_PROVIDER,
    url: env.AI_LOCAL_URL,
    token: env.AI_LOCAL_TOKEN,
    workers: env.WORKERS_ENABLED,
  };

  beforeAll(() => {
    // A configured reader, and an HTTP-only replica: a queued reading waits
    // for the worker service instead of running behind the assertions.
    env.AI_PROVIDER = "local";
    env.AI_LOCAL_URL = "http://127.0.0.1:9";
    env.AI_LOCAL_TOKEN = "t".repeat(40);
    env.WORKERS_ENABLED = false;
  });

  afterAll(() => {
    env.AI_PROVIDER = saved.provider;
    env.AI_LOCAL_URL = saved.url;
    env.AI_LOCAL_TOKEN = saved.token;
    env.WORKERS_ENABLED = saved.workers;
  });

  let cnpjSeq = 0;

  async function company(limit: number): Promise<string> {
    const id = randomUUID();

    cnpjSeq += 1;
    await seedBusiness(id, String(62777777100000 + cnpjSeq));
    await prisma.business.update({
      where: { id },
      data: { ai_analysis_limit: limit },
    });

    return id;
  }

  // A proof's reading: the one kind with no record row to mark when it is
  // refused (a refused fuel reading marks the fuelling skipped).
  function askToRead(businessId: string) {
    return AIAnalysisService.getInstance().requestAnalysis({
      type: "DELIVERY_PROOF",
      recordId: randomUUID(),
      businessId,
      requestedById: randomUUID(),
      input: buildProofAnalysisInput({
        photoPath: `deliveryPhotos/${businessId}/${randomUUID()}.jpg`,
        signaturePath: null,
        delivery: { invoice_number: "45118", recipient_name: "Cliente" },
        provenAt: new Date(),
      }),
    });
  }

  function usage(businessId: string) {
    return app.inject({
      method: "GET",
      url: `/business/get-ai-usage/${businessId}`,
      headers: { authorization: `Bearer ${masterToken}` },
    });
  }

  function setLimit(businessId: string, limit: number) {
    return app.inject({
      method: "PATCH",
      url: `/business/update-ai-limit/${businessId}`,
      headers: { authorization: `Bearer ${masterToken}` },
      payload: { ai_analysis_limit: limit },
    });
  }

  it("reads a limit lowered below this month's use as spent, and refuses the next photo", async () => {
    const lowered = await company(10);

    for (let photo = 0; photo < 6; photo += 1) {
      expect(await askToRead(lowered)).toBe("queued");
    }

    const lowering = await setLimit(lowered, 4);

    expect(lowering.statusCode, lowering.body).toBe(200);

    const data = (await usage(lowered)).json().data;

    // What was read stays read; nothing is left, never a negative balance.
    expect(data.ai_analysis_limit).toBe(4);
    expect(data.ai_analysis_used + data.ai_analysis_in_progress).toBe(6);
    expect(data.ai_analysis_remaining).toBe(0);
    expect(data.ai_analysis_enabled).toBe(true);

    expect(await askToRead(lowered)).toBe("denied");

    // Raised again within the month: the room comes back at once.
    await setLimit(lowered, 7);

    expect(await askToRead(lowered)).toBe("queued");
    expect(await askToRead(lowered)).toBe("denied");
  });

  it("switches the AI off at 0 and says so on the card", async () => {
    const off = await company(3);

    expect((await setLimit(off, 0)).statusCode).toBe(200);

    const data = (await usage(off)).json().data;

    expect(data.ai_analysis_enabled).toBe(false);
    expect(data.ai_analysis_remaining).toBe(0);

    expect(await askToRead(off)).toBe("denied");
  });

  it("starts a new month at midnight in the company's zone, with last month's use behind it", async () => {
    // Manaus (seedBusiness), whose month starts at 04:00 UTC.
    const turned = await company(1);

    const thisMonth = quotaPeriodFor(new Date(), "America/Manaus");
    const lastMonthKey = shiftMonthKey(
      thisMonth.periodStart.toISOString().slice(0, 7),
      -1,
    );

    // Last month spent to the last photo.
    await prisma.aIUsagePeriod.create({
      data: {
        businessId: turned,
        periodStart: new Date(`${lastMonthKey}-01T00:00:00.000Z`),
        consumedUnits: 1,
      },
    });

    expect(await askToRead(turned)).toBe("queued");

    const request = await prisma.aIAnalysisRequest.findFirstOrThrow({
      where: { businessId: turned },
      include: { period: true },
    });

    // Charged to the company's month, keyed by its own day 1.
    expect(request.period.periodStart.toISOString()).toBe(
      thisMonth.periodStart.toISOString(),
    );

    const data = (await usage(turned)).json().data;

    expect(data.ai_analysis_timezone).toBe("America/Manaus");
    expect(data.ai_analysis_reset_at).toBe(thisMonth.startsAt.toISOString());
    expect(data.ai_analysis_remaining).toBe(0);
  });
});
