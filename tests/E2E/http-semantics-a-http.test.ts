import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { decode, sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { hashSecret } from "@/shared/security/bcrypt-gate";

/**
 * Honest statuses on the company and branch routes (decision 11.3), over
 * real HTTP and Postgres.
 *
 * Each refusal below used to leave its controller as `{ message }` with no
 * code — and as a 400 even when nothing was wrong with the request:
 *
 * - a company that does not exist on the MASTER's routes (toggle, AI and
 *   vehicle limits, entitlements, branch deletion) → 404 BUSINESS_NOT_FOUND;
 * - confirming a deletion nobody asked for → 409 *_DELETION_NOT_REQUESTED
 *   (the state refuses it, not the input);
 * - a wrong or expired confirmation code → 400 with its own code;
 * - a company or branch still in use → 409 *_IN_USE.
 *
 * Another company's branch keeps answering exactly like a missing one.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fec00-0000-7000-8000-0000000000a1";
const OTHER = "018fec00-0000-7000-8000-0000000000a2";
const LONELY = "018fec00-0000-7000-8000-0000000000a3";
const MISSING = "018fec00-0000-7000-8000-0000000000ff";
const CODE = "123456";

const tokens: Record<"admin" | "otherAdmin" | "master", string> = {} as never;

let seq = 0;

async function seedBusiness(id: string, name: string) {
  seq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: name,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(84333555000180 + seq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function seedBranch(businessId: string, name: string) {
  seq += 1;

  return prisma.branch.create({
    data: {
      corporate_reason: name,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(74000000000000 + seq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial${seq}-${businessId.slice(-2)}@exemplo.com.br`,
      businessId,
    },
  });
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN",
  businessId: string | null,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

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
    { subject: id, expiresIn: "15m" },
  );
}

const subjectOf = (token: string) => (decode(token) as { sub: string }).sub;

async function seedPending(
  entityType: "branch" | "business",
  entityId: string,
  token: string,
  expiresInMs = 60_000,
) {
  await prisma.pendingDeletion.create({
    data: {
      entity_type: entityType,
      entity_id: entityId,
      userId: subjectOf(token),
      code_hash: await hashSecret(CODE, 4),
      expires: new Date(Date.now() + expiresInMs),
    },
  });
}

const call = (
  method: "GET" | "PATCH" | "PUT" | "DELETE" | "POST",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

/** Status, code in the body AND in the header (the app's queue reads it). */
function expectRefusal(
  response: Awaited<ReturnType<typeof call>>,
  status: number,
  code: string,
) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().code).toBe(code);
  expect(response.headers["x-error-code"]).toBe(code);
  expect(typeof response.json().message).toBe("string");
}

beforeAll(async () => {
  await seedBusiness(CARRIER, "Transportadora Semântica A");
  await seedBusiness(OTHER, "Transportadora Semântica B");
  // No branch, user or driver: the only company a deletion can reach.
  await seedBusiness(LONELY, "Transportadora Sem Vínculos");

  tokens.admin = await seedUser("BUSINESS_ADMIN", CARRIER);
  tokens.otherAdmin = await seedUser("BUSINESS_ADMIN", OTHER);
  tokens.master = await seedUser("MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("a company that does not exist, on the MASTER's routes", () => {
  // Red before: 400 `{ message }` with no code on each of these.
  it.each([
    ["PATCH", `/business/toggle-business-active/${MISSING}`, undefined],
    [
      "PATCH",
      `/business/update-ai-limit/${MISSING}`,
      { ai_analysis_limit: 10 },
    ],
    [
      "PATCH",
      `/business/update-vehicle-limit/${MISSING}`,
      { vehicle_limit: 10 },
    ],
    ["GET", `/business/entitlements/${MISSING}`, undefined],
  ] as const)(
    "%s %s → 404 BUSINESS_NOT_FOUND",
    async (method, url, payload) => {
      expectRefusal(
        await call(method, url, tokens.master, payload),
        404,
        "BUSINESS_NOT_FOUND",
      );
    },
  );

  it("answers the branch deletion steps with 404 BUSINESS_NOT_FOUND too", async () => {
    const branch = await seedBranch(CARRIER, "Filial Qualquer");

    expectRefusal(
      await call(
        "POST",
        `/branch/request-branch-deletion/${branch.id}/business/${MISSING}`,
        tokens.master,
      ),
      404,
      "BUSINESS_NOT_FOUND",
    );
    expectRefusal(
      await call(
        "DELETE",
        `/branch/delete-branch/${branch.id}/business/${MISSING}`,
        tokens.master,
        { code: CODE },
      ),
      404,
      "BUSINESS_NOT_FOUND",
    );
  });

  it("still refuses the routes to a company's administrator by role", async () => {
    const response = await call(
      "PATCH",
      `/business/toggle-business-active/${CARRIER}`,
      tokens.admin,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("AUTH_ROLE_FORBIDDEN");
    expect(
      (await prisma.business.findUniqueOrThrow({ where: { id: CARRIER } }))
        .is_active,
    ).toBe(true);
  });

  it("keeps a validation error a 400, never a 404", async () => {
    expectRefusal(
      await call(
        "PATCH",
        `/business/update-ai-limit/${MISSING}`,
        tokens.master,
        { ai_analysis_limit: -1 },
      ),
      400,
      "VALIDATION_ERROR",
    );
  });
});

describe("confirming a company's deletion", () => {
  const confirm = (businessId: string) =>
    call("DELETE", `/business/delete-business/${businessId}`, tokens.master, {
      code: CODE,
    });

  it("answers 409 BUSINESS_DELETION_NOT_REQUESTED when nobody asked for it", async () => {
    // Red before: 400 with no code — the request was fine, the state was not.
    expectRefusal(
      await confirm(LONELY),
      409,
      "BUSINESS_DELETION_NOT_REQUESTED",
    );
    expect(await prisma.business.count({ where: { id: LONELY } })).toBe(1);
  });

  it("answers a wrong code and an expired one with 400 and their own codes", async () => {
    await seedPending("business", LONELY, tokens.master);

    const wrong = await call(
      "DELETE",
      `/business/delete-business/${LONELY}`,
      tokens.master,
      {
        code: "654321",
      },
    );

    expectRefusal(wrong, 400, "BUSINESS_DELETION_CODE_INVALID");

    await prisma.pendingDeletion.updateMany({
      where: { entity_id: LONELY },
      data: { expires: new Date(Date.now() - 1_000) },
    });

    expectRefusal(await confirm(LONELY), 400, "BUSINESS_DELETION_CODE_EXPIRED");
    expect(await prisma.business.count({ where: { id: LONELY } })).toBe(1);
  });

  it("answers a company still in use with 409 BUSINESS_IN_USE", async () => {
    // Red before: 409 `{ message }` with no code.
    expectRefusal(await confirm(CARRIER), 409, "BUSINESS_IN_USE");
    expectRefusal(
      await call(
        "POST",
        `/business/request-business-deletion/${CARRIER}`,
        tokens.master,
      ),
      409,
      "BUSINESS_IN_USE",
    );
  });

  it("answers a company that does not exist with 404 BUSINESS_NOT_FOUND", async () => {
    expectRefusal(await confirm(MISSING), 404, "BUSINESS_NOT_FOUND");
  });
});

describe("confirming a branch's deletion", () => {
  const confirm = (
    branchId: string,
    businessId: string,
    token = tokens.admin,
    code = CODE,
  ) =>
    call(
      "DELETE",
      `/branch/delete-branch/${branchId}/business/${businessId}`,
      token,
      { code },
    );

  it("answers 409 BRANCH_DELETION_NOT_REQUESTED when nobody asked for it", async () => {
    const branch = await seedBranch(CARRIER, "Filial Sem Pedido");

    // Red before: 400 with no code.
    expectRefusal(
      await confirm(branch.id, CARRIER),
      409,
      "BRANCH_DELETION_NOT_REQUESTED",
    );
    expect(await prisma.branch.count({ where: { id: branch.id } })).toBe(1);
  });

  it("answers a wrong code and an expired one with 400 and their own codes", async () => {
    const branch = await seedBranch(CARRIER, "Filial Com Pedido");

    await seedPending("branch", branch.id, tokens.admin);

    expectRefusal(
      await confirm(branch.id, CARRIER, tokens.admin, "654321"),
      400,
      "BRANCH_DELETION_CODE_INVALID",
    );

    await prisma.pendingDeletion.updateMany({
      where: { entity_id: branch.id },
      data: { expires: new Date(Date.now() - 1_000) },
    });

    expectRefusal(
      await confirm(branch.id, CARRIER),
      400,
      "BRANCH_DELETION_CODE_EXPIRED",
    );
    expect(await prisma.branch.count({ where: { id: branch.id } })).toBe(1);
  });

  it("answers another company's branch exactly like a missing one", async () => {
    const theirs = await seedBranch(OTHER, "Filial Alheia");

    const real = await confirm(theirs.id, CARRIER);
    const fake = await confirm(MISSING, CARRIER);

    expectRefusal(real, 404, "BRANCH_NOT_FOUND");
    expect(real.json()).toEqual(fake.json());
    expect(await prisma.branch.count({ where: { id: theirs.id } })).toBe(1);
  });

  it("refuses another company's administrator on the path of this one", async () => {
    const branch = await seedBranch(CARRIER, "Filial Protegida");

    await seedPending("branch", branch.id, tokens.admin);

    const response = await confirm(branch.id, CARRIER, tokens.otherAdmin);

    expect(response.statusCode).toBe(403);
    expect(await prisma.branch.count({ where: { id: branch.id } })).toBe(1);
  });
});
