import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * The branch gate (verifyBranchActive) must not tell one company which
 * branch ids exist in another (decision 8.1).
 *
 * For anyone but the MASTER, a branchId of another company answered
 * 403 TENANT_ACCESS_DENIED while an id that exists nowhere answered
 * 404 BRANCH_NOT_FOUND. Probing ids was enough to map another carrier's
 * branches. The use cases behind these routes already answer a foreign
 * driver, vehicle or branch like an unknown one; the gate answered first.
 * The inactive foreign branch case was never red (the tenant check already
 * ran before the status check); it stays as a guard on that order.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const RUN = randomUUID().slice(0, 8);

const A = "018fe7b0-0000-7000-8000-0000000000aa";
const B = "018fe7b0-0000-7000-8000-0000000000bb";

const MASTER = "018fe7b0-0000-7000-8000-000000000a01";
const ADMIN_A = "018fe7b0-0000-7000-8000-000000000a02";

const BRANCH_A_INACTIVE = "018fe7b0-0000-7000-8000-00000000b0a2";
const BRANCH_B = "018fe7b0-0000-7000-8000-00000000b0b1";
const BRANCH_B_INACTIVE = "018fe7b0-0000-7000-8000-00000000b0b2";
const NOWHERE = "018fe7b0-0000-7000-8000-00000000dead";

// Never created: the gate runs before the handler looks the bill up.
const BILL = "018fe7b0-0000-7000-8000-00000000f00d";

const tokens: Record<string, string> = {};
let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Filiais ${id.slice(-2)} ${RUN}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `${Date.now()}${Math.floor(Math.random() * 10)}`.slice(-14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filiais-${id}-${RUN}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "FLEET", enabled: true },
  });
}

async function seedBranch(
  id: string,
  businessId: string,
  isActive: boolean,
): Promise<void> {
  cnpjSeq += 1;

  await prisma.branch.create({
    data: {
      id,
      corporate_reason: `Filial ${id.slice(-3)} ${RUN}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61222555000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      is_active: isActive,
      businessId,
    },
  });
}

async function mintToken(
  userId: string,
  role: "MASTER" | "BUSINESS_ADMIN",
  businessId: string | null,
): Promise<string> {
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
    {
      tokenType: "access",
      role,
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);

  await seedBranch(BRANCH_A_INACTIVE, A, false);
  await seedBranch(BRANCH_B, B, true);
  await seedBranch(BRANCH_B_INACTIVE, B, false);

  for (const user of [
    { id: MASTER, role: "MASTER" as const, businessId: null },
    { id: ADMIN_A, role: "BUSINESS_ADMIN" as const, businessId: A },
  ]) {
    await prisma.user.create({
      data: {
        id: user.id,
        name: `Usuário ${user.role} ${RUN}`,
        email: `${user.id}-${RUN}@exemplo.com.br`,
        password: "not-used",
        role: user.role,
        businessId: user.businessId,
      },
    });

    tokens[user.id] = await mintToken(user.id, user.role, user.businessId);
  }

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function moveBill(
  asUser: string,
  businessId: string,
  branchId: string,
): Promise<{ status: number; code?: string; message?: string }> {
  const response = await app.inject({
    method: "PATCH",
    url: `/account-payable/update-account-payable/${BILL}/business/${businessId}`,
    headers: { authorization: `Bearer ${tokens[asUser]}` },
    payload: { branchId },
  });

  const body = response.json() as { code?: string; message?: string };

  return { status: response.statusCode, code: body.code, message: body.message };
}

describe("a company naming a branch that is not its own", () => {
  it("gets the same answer as for a branch that exists nowhere", async () => {
    const nowhere = await moveBill(ADMIN_A, A, NOWHERE);
    const foreign = await moveBill(ADMIN_A, A, BRANCH_B);

    expect(nowhere).toEqual({
      status: 404,
      code: "BRANCH_NOT_FOUND",
      message: "Filial não encontrada!",
    });
    expect(foreign).toEqual(nowhere);
  });

  it("is not told that the foreign branch is switched off either", async () => {
    expect(await moveBill(ADMIN_A, A, BRANCH_B_INACTIVE)).toEqual({
      status: 404,
      code: "BRANCH_NOT_FOUND",
      message: "Filial não encontrada!",
    });
  });

  it("is still told its own branch is switched off", async () => {
    const own = await moveBill(ADMIN_A, A, BRANCH_A_INACTIVE);

    expect(own.status).toBe(403);
    expect(own.code).toBe("BRANCH_INACTIVE");
  });
});

describe("the MASTER, who may name any company", () => {
  it("passes the branch gate for another company's branch", async () => {
    // The gate lets it through; the bill it names does not exist, so the
    // handler answers — anything but the branch gate's own refusals.
    const answer = await moveBill(MASTER, B, BRANCH_B);

    expect(answer.code).not.toBe("BRANCH_NOT_FOUND");
    expect(answer.code).not.toBe("TENANT_ACCESS_DENIED");
    expect(answer.code).not.toBe("BRANCH_INACTIVE");
  });
});
