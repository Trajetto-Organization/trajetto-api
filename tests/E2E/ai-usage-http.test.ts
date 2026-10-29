import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";
import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { quotaPeriodFor } from "@/shared/ai/ai-period";
import { getOrCreateCurrentPeriod } from "@/shared/ai/ai-quota-service";
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
      corporate_reason: `Transportadora ${id.slice(-1)}`,
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
