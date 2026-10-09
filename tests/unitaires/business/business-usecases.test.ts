import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCatalogChangedEvent = vi.hoisted(() => vi.fn());
const sendEntitlementsChangedEvent = vi.hoisted(() => vi.fn());
const sendTransactionalMail = vi.hoisted(() => vi.fn(async (_mail: unknown) => undefined));
const quota = vi.hoisted(() => ({
  getQuotaUsage: vi.fn(),
  getQuotaUsageByType: vi.fn(),
}));
const entitlements = vi.hoisted(() => ({
  getBusinessEntitlements: vi.fn(),
  getModuleImpact: vi.fn(),
  setModuleEnabled: vi.fn(),
}));

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent, sendEntitlementsChangedEvent }));
// The e-mails are beside the point: what matters is who gets refused.
vi.mock("@/shared/services/transactional-mail-service", () => ({ sendTransactionalMail }));
// The quota ledger and the module table are SQL (tests/E2E/ai-usage-http and
// the entitlement E2E cover them); here only how the use case composes them.
vi.mock("@/shared/ai/ai-quota-service", () => quota);
vi.mock("@/shared/entitlements/entitlement-service", () => entitlements);
// The twins have no database to open a transaction on; the row lock taken
// inside it is SQL, proven against Postgres by the E2E suites.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ $queryRaw: async () => [] }),
  },
}));

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business, CreateBusinessProps } from "@/modules/business/dtos/business-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/in-memory/in-memory-pending-deletion-provider";
import { hashSecret } from "@/shared/security/bcrypt-gate";

import { CreateBusinessUseCase } from "@/modules/business/usecases/create-business/create-business-usecase";
import { UpdateBusinessUseCase } from "@/modules/business/usecases/update-business/update-business-usecase";
import { SearchBusinessCursorUseCase } from "@/modules/business/usecases/search-business-cursor/search-business-cursor-usecase";
import { RequestBusinessDeletionUseCase } from "@/modules/business/usecases/request-business-deletion/request-business-deletion-usecase";
import { DeleteBusinessUseCase } from "@/modules/business/usecases/delete-business/delete-business-usecase";
import { GetAIUsageUseCase } from "@/modules/business/usecases/get-ai-usage/get-ai-usage-usecase";
import { UpdateAILimitUseCase } from "@/modules/business/usecases/update-ai-limit/update-ai-limit-usecase";
import { UpdateVehicleLimitUseCase } from "@/modules/business/usecases/update-vehicle-limit/update-vehicle-limit-usecase";
import {
  GetBusinessEntitlementsUseCase,
  GetModuleImpactUseCase,
  UpdateBusinessEntitlementUseCase,
} from "@/modules/business/usecases/manage-entitlements/manage-entitlements-usecase";

/**
 * The company use cases on the in-memory twins. The routes are MASTER-only
 * (except the AI usage and the plan, also open to the company's own admin):
 * these tests cover what the use case itself decides — uniques, the head
 * office mirrored, the deletion code, and the own-company rule.
 */
const MASTER = "018f3200-0000-7000-8000-0000000000f1";
const OTHER_MASTER = "018f3200-0000-7000-8000-0000000000f2";
const ADMIN_A = "018f3200-0000-7000-8000-0000000000a1";
const MISSING = "018f3200-0000-7000-8000-0000000000ee";
const USER_B = "018f3200-0000-7000-8000-0000000000b2";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let branches: InMemoryBranchRepository;
let pending: InMemoryPendingDeletionProvider;
const notifications = { createActivityIfEnabled: vi.fn(async () => undefined) };
const outbox = { publish: vi.fn(async () => undefined) };

const company = (overrides: Partial<CreateBusinessProps> = {}): CreateBusinessProps => ({
  corporate_reason: "Transportadora Alfa Ltda",
  fantasy_name: "Alfa",
  cep: "13010000",
  city: "Campinas",
  uf: "SP",
  street: "Rua Um",
  address_number: "10",
  cnpj: "11111111000111",
  complement: "",
  cnae: "4930202",
  erp_code: "ALFA",
  responsible_name: "Ana Souza",
  telephone: "19999990000",
  email: "contato@alfa.com.br",
  timezone: "America/Sao_Paulo",
  ...overrides,
});

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  branches = new InMemoryBranchRepository();
  pending = new InMemoryPendingDeletionProvider();
  vi.clearAllMocks();

  users.user.push(
    { id: MASTER, role: "MASTER", businessId: null, name: "Mestre", email: "mestre@trajetto.com.br" } as unknown as User,
    {
      id: OTHER_MASTER,
      role: "MASTER",
      businessId: null,
      name: "Outro Mestre",
      email: "outro@trajetto.com.br",
      email_notifications_enabled: true,
    } as unknown as User,
  );
});

const create = () =>
  new CreateBusinessUseCase(users, businesses, branches, notifications as never);
const update = () =>
  new UpdateBusinessUseCase(users, businesses, branches, notifications as never);

/** A company created the way the screen does it, with its admin. */
async function seedCompany(overrides: Partial<CreateBusinessProps> = {}): Promise<Business> {
  const created = await create().execute(company(overrides), MASTER);

  return created;
}

describe("CreateBusinessUseCase", () => {
  it("creates the company and its head office, without the zone on the branch", async () => {
    const created = await seedCompany();

    expect(businesses.business).toHaveLength(1);
    expect(created).toMatchObject({ is_active: true, timezone: "America/Sao_Paulo" });
    expect(branches.branches).toHaveLength(1);
    expect(branches.branches[0]).toMatchObject({
      businessId: created.id,
      cnpj: "11111111000111",
      corporate_reason: "Transportadora Alfa Ltda",
    });
    expect(branches.branches[0]).not.toHaveProperty("timezone");
    expect(notifications.createActivityIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create", entityId: created.id }),
    );
  });

  it.each([
    ["CNPJ", { corporate_reason: "Outra", email: "o@o.com", erp_code: "X" }, "BUSINESS_CNPJ_TAKEN"],
    ["razão social (any case)", { cnpj: "22222222000122", corporate_reason: "TRANSPORTADORA ALFA LTDA", email: "o@o.com", erp_code: "X" }, "BUSINESS_NAME_TAKEN"],
    ["código ERP (any case)", { cnpj: "22222222000122", corporate_reason: "Outra", email: "o@o.com", erp_code: "alfa" }, "BUSINESS_ERP_CODE_TAKEN"],
    ["e-mail (any case)", { cnpj: "22222222000122", corporate_reason: "Outra", erp_code: "X", email: "CONTATO@alfa.com.br" }, "BUSINESS_EMAIL_TAKEN"],
  ])("refuses a taken %s with 409", async (_label, overrides, code) => {
    await seedCompany();

    await expect(create().execute(company(overrides), MASTER)).rejects.toMatchObject({
      statusCode: 409,
      code,
    });
    expect(businesses.business).toHaveLength(1);
  });

  it("refuses a CNPJ already used by another company's branch (409)", async () => {
    const alfa = await seedCompany();
    branches.branches.push({
      ...branches.branches[0],
      id: "018f3200-0000-7000-8000-0000000000b9",
      cnpj: "33333333000133",
      businessId: alfa.id as string,
    });

    await expect(
      create().execute(
        company({ cnpj: "33333333000133", corporate_reason: "Beta", email: "b@b.com", erp_code: "B" }),
        MASTER,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRANCH_CNPJ_UNAVAILABLE" });
  });

  it("does not hold another company's branch name, e-mail or ERP code against the new one", async () => {
    await seedCompany();
    // Beta's head office repeats nothing of Alfa's company row, but Alfa's
    // branch rules are per company (decision 8.1).
    await expect(
      create().execute(
        company({ cnpj: "22222222000122", corporate_reason: "Beta", email: "b@b.com", erp_code: "B" }),
        MASTER,
      ),
    ).resolves.toMatchObject({ corporate_reason: "Beta" });
  });

  it("answers the loser of two simultaneous creates with 409, not 500", async () => {
    // Both look before either writes; the database's unique index decides.
    const results = await Promise.allSettled([
      create().execute(company(), MASTER),
      create().execute(company({ corporate_reason: "Alfa Duplicada", email: "d@d.com", erp_code: "D" }), MASTER),
    ]);

    const rejected = results.filter((result) => result.status === "rejected");

    expect(businesses.business).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: "BUSINESS_CNPJ_TAKEN",
    });
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(create().execute(company(), "nobody")).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
    expect(businesses.business).toHaveLength(0);
  });
});

describe("UpdateBusinessUseCase", () => {
  it("updates the company and mirrors its head office, then hints the branch catalog", async () => {
    const alfa = await seedCompany();

    const updated = await update().execute({
      businessId: alfa.id as string,
      userId: MASTER,
      businessData: { fantasy_name: "Alfa Cargas", timezone: "America/Manaus" },
    });

    expect(updated).toMatchObject({ fantasy_name: "Alfa Cargas", timezone: "America/Manaus" });
    expect(branches.branches[0].fantasy_name).toBe("Alfa Cargas");
    expect(sendCatalogChangedEvent).toHaveBeenCalledWith(alfa.id, "branch");
  });

  it("keeps the company's own values free to resend (no self-conflict)", async () => {
    const alfa = await seedCompany();

    await expect(
      update().execute({
        businessId: alfa.id as string,
        userId: MASTER,
        businessData: {
          cnpj: "11111111000111",
          corporate_reason: "Transportadora Alfa Ltda",
          email: "contato@alfa.com.br",
          erp_code: "ALFA",
        },
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses another company's CNPJ, name, ERP code or e-mail with 409", async () => {
    const alfa = await seedCompany();
    await seedCompany({ cnpj: "22222222000122", corporate_reason: "Beta", email: "b@b.com", erp_code: "B" });

    const attempt = (businessData: Record<string, string>) =>
      update().execute({ businessId: alfa.id as string, userId: MASTER, businessData });

    await expect(attempt({ cnpj: "22222222000122" })).rejects.toMatchObject({ code: "BUSINESS_CNPJ_TAKEN" });
    await expect(attempt({ corporate_reason: "beta" })).rejects.toMatchObject({ code: "BUSINESS_NAME_TAKEN" });
    await expect(attempt({ erp_code: "b" })).rejects.toMatchObject({ code: "BUSINESS_ERP_CODE_TAKEN" });
    await expect(attempt({ email: "B@B.COM" })).rejects.toMatchObject({ code: "BUSINESS_EMAIL_TAKEN" });

    expect(businesses.business.find((row) => row.id === alfa.id)?.corporate_reason).toBe(
      "Transportadora Alfa Ltda",
    );
  });

  it("refuses a name or e-mail taken by one of the company's other branches (409)", async () => {
    const alfa = await seedCompany();
    branches.branches.push({
      ...branches.branches[0],
      id: "018f3200-0000-7000-8000-0000000000b8",
      cnpj: "44444444000144",
      corporate_reason: "Alfa Filial Sul",
      email: "sul@alfa.com.br",
      erp_code: "SUL",
    });

    const attempt = (businessData: Record<string, string>) =>
      update().execute({ businessId: alfa.id as string, userId: MASTER, businessData });

    await expect(attempt({ corporate_reason: "Alfa Filial Sul" })).rejects.toMatchObject({
      statusCode: 409,
      code: "BRANCH_NAME_TAKEN",
    });
    await expect(attempt({ email: "sul@alfa.com.br" })).rejects.toMatchObject({ code: "BRANCH_EMAIL_TAKEN" });
    await expect(attempt({ erp_code: "SUL" })).rejects.toMatchObject({ code: "BRANCH_ERP_CODE_TAKEN" });
    await expect(attempt({ cnpj: "44444444000144" })).rejects.toMatchObject({ code: "BRANCH_CNPJ_UNAVAILABLE" });
  });

  it("answers 404 for an unknown company or session user", async () => {
    await expect(
      update().execute({ businessId: MISSING, userId: MASTER, businessData: { fantasy_name: "X" } }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });

    const alfa = await seedCompany();
    await expect(
      update().execute({ businessId: alfa.id as string, userId: "nobody", businessData: {} }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });

  it("reports a head-office conflict as the branch's 409, not the company's", async () => {
    // A sibling branch takes the e-mail after the lookups (a race): the P2002
    // comes from the branch table and must not read BUSINESS_EMAIL_TAKEN.
    const alfa = await seedCompany();
    const lookup = branches.findBranchByEmail.bind(branches);

    branches.findBranchByEmail = async (businessId: string, email: string) => {
      const found = await lookup(businessId, email);

      await branches.createBranch({
        ...company({ cnpj: "33333333000133", corporate_reason: "Filial Norte", erp_code: "N", email }),
        businessId,
      } as never);

      return found;
    };

    const error = await update()
      .execute({ businessId: alfa.id as string, userId: MASTER, businessData: { email: "novo@alfa.com.br" } })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ statusCode: 409, code: "BRANCH_EMAIL_TAKEN" });
  });

  it("answers the loser of a simultaneous rename with 409, not 500", async () => {
    const alfa = await seedCompany();
    const beta = await seedCompany({ cnpj: "22222222000122", corporate_reason: "Beta", email: "b@b.com", erp_code: "B" });

    const results = await Promise.allSettled([
      update().execute({ businessId: alfa.id as string, userId: MASTER, businessData: { email: "novo@x.com" } }),
      update().execute({ businessId: beta.id as string, userId: MASTER, businessData: { email: "novo@x.com" } }),
    ]);

    const rejected = results.filter((result) => result.status === "rejected");

    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: "BUSINESS_EMAIL_TAKEN",
    });
  });
});

describe("SearchBusinessCursorUseCase", () => {
  it("lets the MASTER walk every active company and keeps an admin on their own", async () => {
    const alfa = await seedCompany();
    const beta = await seedCompany({ cnpj: "22222222000122", corporate_reason: "Beta", email: "b@b.com", erp_code: "B" });
    await seedCompany({ cnpj: "33333333000133", corporate_reason: "Gama", email: "g@g.com", erp_code: "G" });
    businesses.business.find((row) => row.corporate_reason === "Gama")!.is_active = false;
    users.user.push({ id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: alfa.id } as User);

    const all = await new SearchBusinessCursorUseCase(users, businesses).execute({ userId: MASTER, limit: 1 });
    expect(all.data).toHaveLength(1);
    expect(all.hasMore).toBe(true);

    const rest = await new SearchBusinessCursorUseCase(users, businesses).execute({
      userId: MASTER,
      limit: 5,
      cursor: all.nextCursor as string,
    });
    expect([...all.data, ...rest.data].map((row) => row.id).sort()).toEqual([alfa.id, beta.id].sort());

    const own = await new SearchBusinessCursorUseCase(users, businesses).execute({ userId: ADMIN_A, search: "beta" });
    expect(own.data).toEqual([]);
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(
      new SearchBusinessCursorUseCase(users, businesses).execute({ userId: "nobody" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});

describe("deleting a company with a code by e-mail", () => {
  const request = () => new RequestBusinessDeletionUseCase(users, businesses, pending);
  const remove = () => new DeleteBusinessUseCase(users, businesses, pending, notifications as never);

  async function emptyCompany(): Promise<string> {
    // A company with no branch, user or driver left: the only deletable one.
    const id = "018f3200-0000-7000-8000-0000000000c1";
    businesses.business.push({ id, corporate_reason: "Vazia", cnpj: "55555555000155", timezone: "America/Sao_Paulo" } as Business);

    return id;
  }

  async function arm(businessId: string, code: string, expires = new Date(Date.now() + 60_000)) {
    await pending.upsertPendingDeletion({
      entity_type: "business",
      entity_id: businessId,
      userId: MASTER,
      code_hash: await hashSecret(code, 4),
      expires,
    });
  }

  it("sends the code to the requester and stores only its hash", async () => {
    const id = await emptyCompany();

    const result = await request().execute(id, MASTER);

    expect(result.message).toContain("código de confirmação");
    expect(pending.pendingDeletions).toHaveLength(1);
    expect(pending.pendingDeletions[0]).toMatchObject({ entity_type: "business", entity_id: id, userId: MASTER });
    const sent = sendTransactionalMail.mock.calls[0][0] as unknown as {
      email: string;
      additionalVariablesProperties: { code: string };
    };
    expect(sent.email).toBe("mestre@trajetto.com.br");
    expect(sent.additionalVariablesProperties.code).toMatch(/^\d{6}$/);
    expect(pending.pendingDeletions[0].code_hash).not.toBe(sent.additionalVariablesProperties.code);
  });

  it("refuses to send a code for a company that still has branches, users or drivers (409)", async () => {
    const alfa = await seedCompany();
    businesses.dependents.branches.push({ businessId: alfa.id as string });
    businesses.dependents.users.push({ businessId: alfa.id as string });

    await expect(request().execute(alfa.id as string, MASTER)).rejects.toMatchObject({
      statusCode: 409,
      code: "BUSINESS_IN_USE",
      message: expect.stringContaining("1 filial(is) vinculada(s), 1 usuário(s) vinculado(s)"),
    });
    expect(sendTransactionalMail).not.toHaveBeenCalled();
  });

  it("deletes with the right code, records it and tells the other masters", async () => {
    const id = await emptyCompany();
    await arm(id, "123456");

    const deleted = await remove().execute(id, MASTER, "123456");

    expect(deleted.id).toBe(id);
    expect(businesses.business).toHaveLength(0);
    expect(pending.pendingDeletions).toHaveLength(0);
    expect(notifications.createActivityIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", entityId: id, businessId: null, tenantName: "Vazia" }),
      expect.anything(),
    );
    await vi.waitFor(() =>
      expect(sendTransactionalMail).toHaveBeenCalledWith(
        expect.objectContaining({ email: "outro@trajetto.com.br" }),
      ),
    );
  });

  it("refuses a wrong code (400) and keeps the company and the pending request", async () => {
    const id = await emptyCompany();
    await arm(id, "123456");

    await expect(remove().execute(id, MASTER, "654321")).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_DELETION_CODE_INVALID",
    });
    expect(businesses.business).toHaveLength(1);
    expect(pending.pendingDeletions).toHaveLength(1);
  });

  it("refuses an expired code (400) and drops it", async () => {
    const id = await emptyCompany();
    await arm(id, "123456", new Date(Date.now() - 1000));

    await expect(remove().execute(id, MASTER, "123456")).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_DELETION_CODE_EXPIRED",
    });
    expect(pending.pendingDeletions).toHaveLength(0);
    expect(businesses.business).toHaveLength(1);
  });

  it("refuses without a request of this master (409), even when another master asked", async () => {
    const id = await emptyCompany();
    await pending.upsertPendingDeletion({
      entity_type: "business",
      entity_id: id,
      userId: OTHER_MASTER,
      code_hash: await hashSecret("123456", 4),
      expires: new Date(Date.now() + 60_000),
    });

    await expect(remove().execute(id, MASTER, "123456")).rejects.toMatchObject({
      statusCode: 409,
      code: "BUSINESS_DELETION_NOT_REQUESTED",
    });
    expect(businesses.business).toHaveLength(1);
  });

  it("re-checks the dependencies at deletion time (409)", async () => {
    const id = await emptyCompany();
    await arm(id, "123456");
    businesses.dependents.drivers.push({ businessId: id });

    await expect(remove().execute(id, MASTER, "123456")).rejects.toMatchObject({
      statusCode: 409,
      code: "BUSINESS_IN_USE",
    });
    expect(businesses.business).toHaveLength(1);
  });

  it("answers 404 for an unknown company or session user", async () => {
    await expect(request().execute(MISSING, MASTER)).rejects.toMatchObject({ code: "BUSINESS_NOT_FOUND" });
    await expect(remove().execute(MISSING, MASTER, "123456")).rejects.toMatchObject({ code: "BUSINESS_NOT_FOUND" });
    await expect(request().execute(MISSING, "nobody")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });
});

describe("the company's AI usage and limits", () => {
  let alfaId: string;
  let betaId: string;

  beforeEach(async () => {
    alfaId = (await seedCompany()).id as string;
    betaId = (await seedCompany({ cnpj: "22222222000122", corporate_reason: "Beta", email: "b@b.com", erp_code: "B" })).id as string;
    businesses.business.find((row) => row.id === alfaId)!.ai_analysis_limit = 50;
    users.user.push({ id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: alfaId, name: "Ana", email: "ana@alfa.com.br" } as User);
  });

  it("composes the ledger into the response, ISO instants and remaining included", async () => {
    quota.getQuotaUsage.mockResolvedValue({
      periodId: "period-1",
      consumed: 12,
      inProgress: 2,
      remaining: 36,
      startsAt: new Date("2026-10-01T03:00:00.000Z"),
      resetAt: new Date("2026-11-01T03:00:00.000Z"),
      timeZone: "America/Sao_Paulo",
    });
    quota.getQuotaUsageByType.mockResolvedValue({ fuel: 5, checklist: 7, proof: 0 });

    const usage = await new GetAIUsageUseCase(users, businesses).execute({ userId: ADMIN_A, businessId: alfaId });

    expect(usage).toMatchObject({
      id: alfaId,
      ai_analysis_limit: 50,
      ai_analysis_used: 12,
      ai_analysis_in_progress: 2,
      ai_analysis_remaining: 36,
      ai_analysis_reset_at: "2026-10-01T03:00:00.000Z",
      ai_analysis_next_reset_at: "2026-11-01T03:00:00.000Z",
      ai_analysis_enabled: true,
      ai_analysis_used_by_type: { fuel: 5, checklist: 7, proof: 0 },
    });
  });

  it("without a ledger period yet, the whole limit remains and nothing was used", async () => {
    quota.getQuotaUsage.mockResolvedValue(null);

    const usage = await new GetAIUsageUseCase(users, businesses).execute({ userId: MASTER, businessId: alfaId });

    expect(usage).toMatchObject({ ai_analysis_used: 0, ai_analysis_remaining: 50, ai_analysis_reset_at: null });
    expect(quota.getQuotaUsageByType).not.toHaveBeenCalled();
  });

  it("refuses another company's usage to an admin with the route's 403 TENANT_ACCESS_DENIED", async () => {
    // Same answer as the route guard (business-routes Swagger), not a 404.
    await expect(
      new GetAIUsageUseCase(users, businesses).execute({ userId: ADMIN_A, businessId: betaId }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    expect(quota.getQuotaUsage).not.toHaveBeenCalled();
  });

  it("refuses a plain user, even of another company, with 403 AUTH_ROLE_FORBIDDEN", async () => {
    // The old check only looked at BUSINESS_ADMIN: a BUSINESS_USER read any
    // company's usage.
    users.user.push({ id: USER_B, role: "BUSINESS_USER", businessId: betaId } as User);

    await expect(
      new GetAIUsageUseCase(users, businesses).execute({ userId: USER_B, businessId: alfaId }),
    ).rejects.toMatchObject({ statusCode: 403, code: "AUTH_ROLE_FORBIDDEN" });
    expect(quota.getQuotaUsage).not.toHaveBeenCalled();
  });

  it("refuses a limit change by an admin, even on their own company, before writing (MASTER-only)", async () => {
    // The route is MASTER-only; the use case let an admin raise their own
    // company's limits when that guard was missing.
    const ai = new UpdateAILimitUseCase(users, businesses, outbox as never);
    const fleet = new UpdateVehicleLimitUseCase(users, businesses, outbox as never);

    for (const businessId of [alfaId, betaId]) {
      await expect(ai.execute({ userId: ADMIN_A, businessId, ai_analysis_limit: 999 })).rejects.toMatchObject({
        statusCode: 403,
        code: "AUTH_ROLE_FORBIDDEN",
      });
      await expect(fleet.execute({ userId: ADMIN_A, businessId, vehicle_limit: 999 })).rejects.toMatchObject({
        statusCode: 403,
        code: "AUTH_ROLE_FORBIDDEN",
      });
    }

    expect(outbox.publish).not.toHaveBeenCalled();
    expect(businesses.business.find((row) => row.id === alfaId)?.ai_analysis_limit).toBe(50);
  });

  it("refuses a limit change with an unknown user or company, before writing", async () => {
    const ai = new UpdateAILimitUseCase(users, businesses, outbox as never);
    const fleet = new UpdateVehicleLimitUseCase(users, businesses, outbox as never);

    await expect(ai.execute({ userId: MASTER, businessId: MISSING, ai_analysis_limit: 10 })).rejects.toMatchObject({
      code: "BUSINESS_NOT_FOUND",
    });
    await expect(fleet.execute({ userId: "nobody", businessId: alfaId, vehicle_limit: 10 })).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });

    expect(outbox.publish).not.toHaveBeenCalled();
    expect(businesses.business.find((row) => row.id === betaId)?.vehicle_limit ?? 0).toBe(0);
  });
});

describe("the company's plan (modules)", () => {
  let alfaId: string;
  let betaId: string;
  const vehicles = {
    countActiveVehiclesByBusinessId: vi.fn(async () => 7),
    countInactiveVehiclesByBusinessId: vi.fn(async () => 2),
  };

  beforeEach(async () => {
    alfaId = (await seedCompany()).id as string;
    betaId = (await seedCompany({ cnpj: "22222222000122", corporate_reason: "Beta", email: "b@b.com", erp_code: "B" })).id as string;
    businesses.business.find((row) => row.id === alfaId)!.vehicle_limit = 10;
    users.user.push({ id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: alfaId } as User);
    entitlements.getBusinessEntitlements.mockResolvedValue([{ module: "FLEET", enabled: true }]);
  });

  it("answers the admin's own plan with the fleet usage", async () => {
    const plan = await new GetBusinessEntitlementsUseCase(users, businesses, vehicles as never).execute({
      userId: ADMIN_A,
      businessId: alfaId,
    });

    expect(plan).toEqual({
      modules: [{ module: "FLEET", enabled: true }],
      vehicle_limit: 10,
      vehicle_count: 7,
      vehicle_inactive_count: 2,
      vehicle_limit_enabled: true,
    });
  });

  it("refuses another company's plan to an admin with the route's 403 TENANT_ACCESS_DENIED", async () => {
    await expect(
      new GetBusinessEntitlementsUseCase(users, businesses, vehicles as never).execute({
        userId: ADMIN_A,
        businessId: betaId,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    expect(entitlements.getBusinessEntitlements).not.toHaveBeenCalled();
  });

  it("refuses a plain user of the company with 403 AUTH_ROLE_FORBIDDEN, like the route", async () => {
    users.user.push({ id: USER_B, role: "BUSINESS_USER", businessId: alfaId } as User);

    await expect(
      new GetBusinessEntitlementsUseCase(users, businesses, vehicles as never).execute({
        userId: USER_B,
        businessId: alfaId,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "AUTH_ROLE_FORBIDDEN" });
  });

  it("refuses a module switch by the company's own admin (MASTER-only), writing nothing", async () => {
    await expect(
      new UpdateBusinessEntitlementUseCase(users, businesses, outbox as never).execute({
        userId: ADMIN_A,
        businessId: alfaId,
        module: "DELIVERIES",
        enabled: true,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "AUTH_ROLE_FORBIDDEN" });

    expect(entitlements.setModuleEnabled).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it("404s the impact count and the switch for an unknown company, writing nothing", async () => {
    await expect(
      new GetModuleImpactUseCase(businesses).execute({ userId: MASTER, businessId: MISSING, module: "FLEET" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });

    await expect(
      new UpdateBusinessEntitlementUseCase(users, businesses, outbox as never).execute({
        userId: MASTER,
        businessId: MISSING,
        module: "FLEET",
        enabled: false,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });

    expect(entitlements.setModuleEnabled).not.toHaveBeenCalled();
    expect(sendEntitlementsChangedEvent).not.toHaveBeenCalled();
  });

  it("re-affirming the current state is no change: no write, no notice, no event", async () => {
    await new UpdateBusinessEntitlementUseCase(users, businesses, outbox as never).execute({
      userId: MASTER,
      businessId: alfaId,
      module: "FLEET",
      enabled: true,
    });

    expect(entitlements.setModuleEnabled).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
    expect(sendEntitlementsChangedEvent).not.toHaveBeenCalled();
  });

  it("a real switch writes, publishes the movement and then tells the clients", async () => {
    await new UpdateBusinessEntitlementUseCase(users, businesses, outbox as never).execute({
      userId: MASTER,
      businessId: alfaId,
      module: "FLEET",
      enabled: false,
    });

    expect(entitlements.setModuleEnabled).toHaveBeenCalledWith(alfaId, "FLEET", false, expect.anything());
    expect(outbox.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        topic: "business-module.changed",
        payload: expect.objectContaining({ enabled: false, previousEnabled: true }),
      }),
    );
    expect(sendEntitlementsChangedEvent).toHaveBeenCalledWith(alfaId, { module: "FLEET", enabled: false });
  });
});

describe("the company writes are MASTER-only inside the use case too", () => {
  // The routes say MASTER; these use cases trusted the route alone, so a
  // missing or regressed guard let a company admin manage companies.
  const FORBIDDEN = { statusCode: 403, code: "AUTH_ROLE_FORBIDDEN" };
  let alfaId: string;

  beforeEach(async () => {
    alfaId = (await seedCompany()).id as string;
    users.user.push({ id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: alfaId, name: "Ana", email: "ana@alfa.com.br" } as User);
  });

  it("refuses an admin creating a company", async () => {
    await expect(
      create().execute(company({ cnpj: "44444444000144", corporate_reason: "Gama", email: "g@g.com", erp_code: "G" }), ADMIN_A),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(businesses.business).toHaveLength(1);
  });

  it("refuses an admin renaming their own company", async () => {
    await expect(
      update().execute({ businessId: alfaId, userId: ADMIN_A, businessData: { fantasy_name: "Tomada" } }),
    ).rejects.toMatchObject(FORBIDDEN);
    expect(businesses.business[0].fantasy_name).toBe("Alfa");
  });

  it("refuses an admin asking for, or confirming, the deletion of their own company", async () => {
    await expect(
      new RequestBusinessDeletionUseCase(users, businesses, pending).execute(alfaId, ADMIN_A),
    ).rejects.toMatchObject(FORBIDDEN);
    await expect(
      new DeleteBusinessUseCase(users, businesses, pending, notifications as never).execute(alfaId, ADMIN_A, "123456"),
    ).rejects.toMatchObject(FORBIDDEN);

    expect(pending.pendingDeletions).toHaveLength(0);
    expect(sendTransactionalMail).not.toHaveBeenCalled();
    expect(businesses.business).toHaveLength(1);
  });
});
