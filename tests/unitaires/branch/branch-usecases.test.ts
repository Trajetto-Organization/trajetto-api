import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCatalogChangedEvent = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent }));

// The deletion e-mails are beside the point here.
vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: vi.fn(async () => undefined),
}));

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { CreateBranchUseCase } from "@/modules/branch/usecases/create-branch/create-branch-usecase";
import { UpdateBranchUseCase } from "@/modules/branch/usecases/update-branch/update-branch-usecase";
import { ToggleBranchActiveUseCase } from "@/modules/branch/usecases/toggle-branch-active/toggle-branch-active-usecase";
import { ListBranchUseCase } from "@/modules/branch/usecases/list-branch/list-branch-usecase";
import { DeleteBranchUseCase } from "@/modules/branch/usecases/delete-branch/delete-branch-usecase";
import { RequestBranchDeletionUseCase } from "@/modules/branch/usecases/request-branch-deletion/request-branch-deletion-usecase";
import { InMemoryPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/in-memory/in-memory-pending-deletion-provider";
import { hashSecret } from "@/shared/security/bcrypt-gate";

import { BranchNameAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-name-already-exists-error";
import { BranchEmailAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-email-already-exists-error";
import { BranchErpCodeAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-erp-code-already-exists-error";
import { BranchCnpjAlreadyExistsError } from "@/modules/branch/usecases/errors/branch-cnpj-already-exists-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchDeletionCodeInvalidError } from "@/modules/branch/usecases/errors/branch-deletion-code-invalid-error";

import type { CreateBranchProps } from "@/modules/branch/dtos/branch-dto";

/**
 * Branches: uniques inside ONE company (decision 8.1) with answers that name
 * no other tenant, another company's branch answering like a missing one,
 * and `catalogChanged` (branch) after every write — only after it happened.
 */
const A = "018feb00-0000-7000-8000-00000000000a";
const B = "018feb00-0000-7000-8000-00000000000b";

const people: Record<
  string,
  { id: string; role: string; businessId: string | null }
> = {
  adminA: { id: "adminA", role: "BUSINESS_ADMIN", businessId: A },
  adminB: { id: "adminB", role: "BUSINESS_ADMIN", businessId: B },
  master: { id: "master", role: "MASTER", businessId: null },
};

const companies: Record<
  string,
  { id: string; corporate_reason: string; cnpj: string; email: string }
> = {
  [A]: {
    id: A,
    corporate_reason: "Transportadora A",
    cnpj: "11111111000111",
    email: "a@a.com",
  },
  [B]: {
    id: B,
    corporate_reason: "Transportadora Beta Segredo",
    cnpj: "22222222000122",
    email: "b@b.com",
  },
};

let branches: InMemoryBranchRepository;

const users = {
  findUserById: async (id: string) =>
    people[id]
      ? { ...people[id], name: id, email: `${id}@exemplo.com.br` }
      : null,
  findBusinessAdminsByBusinessId: async () => [],
} as never;

const business = {
  findBusinessById: async (id: string) => companies[id] ?? null,
  findBusinessByCnpj: async (cnpj: string) =>
    Object.values(companies).find((company) => company.cnpj === cnpj) ?? null,
} as never;

const notifications = { createActivityIfEnabled: vi.fn() } as never;

const branch = (
  overrides: Partial<CreateBranchProps> = {},
): CreateBranchProps => ({
  corporate_reason: "Filial Campinas",
  fantasy_name: "",
  cep: "13010000",
  city: "Campinas",
  uf: "SP",
  street: "Rua Um",
  address_number: "10",
  cnpj: "33333333000133",
  complement: "",
  cnae: "4930202",
  erp_code: "001",
  responsible_name: "Ana Souza",
  telephone: "19999999999",
  email: "campinas@exemplo.com.br",
  businessId: A,
  ...overrides,
});

const setup = () => ({
  create: new CreateBranchUseCase(users, business, branches, notifications),
  update: new UpdateBranchUseCase(users, business, branches, notifications),
  toggle: new ToggleBranchActiveUseCase(
    users,
    business,
    branches,
    notifications,
  ),
  list: new ListBranchUseCase(users, branches),
});

beforeEach(() => {
  branches = new InMemoryBranchRepository();
  sendCatalogChangedEvent.mockClear();
});

describe("uniqueness inside one company (decision 8.1)", () => {
  it("lets another carrier register a branch with the same name, e-mail and ERP code", async () => {
    const { create } = setup();

    await create.execute(branch(), A, "adminA");

    // Globally checked, B's registration was refused and told B that the
    // name belonged to someone.
    await expect(
      create.execute(
        branch({ cnpj: "44444444000144", businessId: B }),
        B,
        "adminB",
      ),
    ).resolves.toMatchObject({
      corporate_reason: "Filial Campinas",
      businessId: B,
    });
  });

  it("refuses the same name (ignoring case), e-mail or ERP code in the same company, with a 409 code", async () => {
    const { create } = setup();

    await create.execute(branch(), A, "adminA");

    await expect(
      create.execute(
        branch({ corporate_reason: "FILIAL CAMPINAS", cnpj: "55555555000155" }),
        A,
        "adminA",
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "BRANCH_NAME_TAKEN" });

    await expect(
      create.execute(
        branch({
          corporate_reason: "Outra",
          cnpj: "55555555000155",
          erp_code: "002",
        }),
        A,
        "adminA",
      ),
    ).rejects.toBeInstanceOf(BranchEmailAlreadyExistsError);

    await expect(
      create.execute(
        branch({
          corporate_reason: "Outra",
          cnpj: "55555555000155",
          email: "outra@exemplo.com.br",
        }),
        A,
        "adminA",
      ),
    ).rejects.toBeInstanceOf(BranchErpCodeAlreadyExistsError);
  });

  it("answers a CNPJ taken anywhere with the same neutral 409, naming nobody", async () => {
    const { create } = setup();

    await create.execute(branch({ businessId: B }), B, "adminB");

    const byBranch = create.execute(
      branch({ corporate_reason: "X", email: "x@x.com", erp_code: "9" }),
      A,
      "adminA",
    );

    await expect(byBranch).rejects.toBeInstanceOf(BranchCnpjAlreadyExistsError);

    // A company's own CNPJ used by another carrier: the same answer, not
    // "cadastrado em uma empresa".
    const byCompany = create.execute(
      branch({
        cnpj: companies[B].cnpj,
        corporate_reason: "Y",
        email: "y@y.com",
        erp_code: "8",
      }),
      A,
      "adminA",
    );

    await expect(byCompany).rejects.toMatchObject({
      statusCode: 409,
      code: "BRANCH_CNPJ_UNAVAILABLE",
    });
    await byCompany.catch((error: Error) => {
      expect(error.message).not.toContain(companies[B].corporate_reason);
    });
  });

  it("turns a lost race (P2002 on the index) into the same 409, not a 500", async () => {
    const { create } = setup();

    await create.execute(branch(), A, "adminA");

    // Both requests looked before either wrote: the check found nothing.
    vi.spyOn(branches, "findBranchByCorporateReason").mockResolvedValueOnce(
      null,
    );

    await expect(
      create.execute(
        branch({ cnpj: "66666666000166", email: "z@z.com", erp_code: "7" }),
        A,
        "adminA",
      ),
    ).rejects.toBeInstanceOf(BranchNameAlreadyExistsError);
  });
});

describe("another company's branch", () => {
  it("answers like a missing one (404), for the MASTER too, and is not written", async () => {
    const { create, update, toggle } = setup();

    const foreign = await create.execute(
      branch({ businessId: B }),
      B,
      "adminB",
    );

    await expect(
      update.execute({ corporate_reason: "Tomada" }, foreign.id, A, "master"),
    ).rejects.toMatchObject({ statusCode: 404, code: "BRANCH_NOT_FOUND" });

    await expect(
      toggle.execute(foreign.id, A, "adminA"),
    ).rejects.toBeInstanceOf(BranchNotFoundError);

    expect(branches.branches[0]).toMatchObject({
      corporate_reason: "Filial Campinas",
      is_active: true,
    });
  });
});

describe("catalogChanged branch", () => {
  it("is emitted after create, update and toggle, for the company written", async () => {
    const { create, update, toggle } = setup();

    const created = await create.execute(branch(), A, "adminA");
    await update.execute(
      { corporate_reason: "Filial Centro" },
      created.id,
      A,
      "adminA",
    );
    await toggle.execute(created.id, A, "adminA");

    // The toggle also tells the driver pickers: a driver of an inactive
    // branch leaves the chat's "com o app" list (chat-web, decision 2.3).
    expect(sendCatalogChangedEvent.mock.calls).toEqual([
      [A, "branch"],
      [A, "branch"],
      [A, "branch"],
      [A, "driver"],
    ]);
  });

  it("is not emitted when the write is refused", async () => {
    const { create } = setup();

    await create.execute(branch(), A, "adminA");
    sendCatalogChangedEvent.mockClear();

    await expect(
      create.execute(branch({ cnpj: "77777777000177" }), A, "adminA"),
    ).rejects.toBeInstanceOf(BranchNameAlreadyExistsError);

    expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
  });
});

describe("the list", () => {
  it("makes the MASTER name the company and refuses another company's manager", async () => {
    const { list } = setup();

    await expect(
      list.execute({ userId: "master", page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    await expect(
      list.execute({ userId: "adminA", businessId: B, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("counts the cards over the company, not over the page", async () => {
    const { create, toggle, list } = setup();

    for (let index = 0; index < 12; index += 1) {
      const created = await create.execute(
        branch({
          corporate_reason: `Filial ${index}`,
          cnpj: String(10000000000000 + index),
          email: `f${index}@exemplo.com.br`,
          erp_code: index % 3 === 0 ? `E${index}` : "",
          fantasy_name: index % 2 === 0 ? `Fantasia ${index}` : "",
          uf: index < 4 ? "RJ" : "SP",
        }),
        A,
        "adminA",
      );

      if (index === 11) await toggle.execute(created.id, A, "adminA");
    }

    const page = await list.execute({
      userId: "adminA",
      page: 1,
      pageSize: 10,
    });

    expect(page.data).toHaveLength(10);
    expect(page.searchMeta).toMatchObject({
      total: 12,
      active: 11,
      withErpCode: 4,
      withFantasyName: 6,
    });

    // One facet narrows the table; its own options keep counting the rest.
    const rj = await list.execute({
      userId: "adminA",
      page: 1,
      pageSize: 10,
      ufs: ["RJ"],
    });

    expect(rj.total).toBe(4);
    expect(rj.searchMeta.facets.uf).toEqual([
      { value: "RJ", count: 4 },
      { value: "SP", count: 8 },
    ]);
    expect(rj.searchMeta.facets.status).toEqual([
      { value: "active", count: 4 },
      { value: "inactive", count: 0 },
    ]);

    // The "Ativas" card is a breakdown by the status facet: picking
    // "Inativa" narrows the table, it does not turn the card into zero
    // (the disjunctive rule of decision 8.8).
    const inactive = await list.execute({
      userId: "adminA",
      page: 1,
      pageSize: 10,
      statuses: ["inactive"],
    });

    expect(inactive.total).toBe(1);
    expect(inactive.searchMeta).toMatchObject({ total: 1, active: 11 });

    // Still under the other facets: UF applied, status not.
    const rjInactive = await list.execute({
      userId: "adminA",
      page: 1,
      pageSize: 10,
      statuses: ["inactive"],
      ufs: ["RJ"],
    });

    expect(rjInactive.total).toBe(0);
    expect(rjInactive.searchMeta.active).toBe(4);
  });
});

describe("InMemoryBranchRepository answers like the repository", () => {
  it("keeps the columns a partial update did not send", async () => {
    const created = await branches.createBranch(branch());

    await branches.updateBranch({
      branchId: created.id,
      branchData: { city: "Jundiaí" },
    });

    expect(branches.branches[0]).toMatchObject({
      city: "Jundiaí",
      erp_code: "001",
      fantasy_name: null,
    });
  });

  it("orders by the key asked, NULLs last, and breaks ties newest first", async () => {
    const first = await branches.createBranch(branch({ fantasy_name: "Beta" }));
    const second = await branches.createBranch(
      branch({
        corporate_reason: "B",
        cnpj: "1",
        email: "1@x.com",
        erp_code: "1",
        fantasy_name: "",
      }),
    );
    const third = await branches.createBranch(
      branch({
        corporate_reason: "C",
        cnpj: "2",
        email: "2@x.com",
        erp_code: "2",
        fantasy_name: "Alfa",
      }),
    );

    const { data } = await branches.listAllBranches({
      page: 1,
      pageSize: 10,
      businessId: A,
      sort: "fantasy_name",
      order: "desc",
    });

    expect(data.map((row) => row.id)).toEqual([first.id, third.id, second.id]);
  });
});

describe("deleting a branch", () => {
  const CODE = "123456";

  const armed = async (
    pending: InMemoryPendingDeletionProvider,
    branchId: string,
    userId: string,
  ) =>
    pending.upsertPendingDeletion({
      entity_type: "branch",
      entity_id: branchId,
      userId,
      code_hash: await hashSecret(CODE, 4),
      expires: new Date(Date.now() + 60_000),
    });

  it("emits catalogChanged for the company once the branch is gone", async () => {
    const { create } = setup();
    const pending = new InMemoryPendingDeletionProvider();
    const remove = new DeleteBranchUseCase(
      users,
      business,
      branches,
      pending,
      notifications,
    );

    const created = await create.execute(branch(), A, "adminA");
    await armed(pending, created.id, "adminA");
    sendCatalogChangedEvent.mockClear();

    await remove.execute(created.id, A, "adminA", CODE);

    expect(await branches.findBranchById(created.id)).toBeNull();
    expect(sendCatalogChangedEvent.mock.calls).toEqual([[A, "branch"]]);
  });

  it("answers another company's branch like a missing one, on both steps, and emits nothing", async () => {
    const { create } = setup();
    const pending = new InMemoryPendingDeletionProvider();
    const request = new RequestBranchDeletionUseCase(
      users,
      business,
      branches,
      pending,
    );
    const remove = new DeleteBranchUseCase(
      users,
      business,
      branches,
      pending,
      notifications,
    );

    const created = await create.execute(branch(), A, "adminA");
    await armed(pending, created.id, "adminB");
    sendCatalogChangedEvent.mockClear();

    // Through their own path: not found, exactly as an id that does not exist.
    await expect(
      request.execute(created.id, B, "adminB"),
    ).rejects.toBeInstanceOf(BranchNotFoundError);
    await expect(
      remove.execute(created.id, B, "adminB", CODE),
    ).rejects.toBeInstanceOf(BranchNotFoundError);

    // Through A's path: the tenant refusal, before the branch is looked at.
    await expect(
      request.execute(created.id, A, "adminB"),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      remove.execute(created.id, A, "adminB", CODE),
    ).rejects.toMatchObject({
      statusCode: 403,
    });

    expect(await branches.findBranchById(created.id)).not.toBeNull();
    expect(
      pending.pendingDeletions.filter((entry) => entry.userId === "adminB"),
    ).toHaveLength(1);
    expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
  });

  it("emits nothing when the code is wrong", async () => {
    const { create } = setup();
    const pending = new InMemoryPendingDeletionProvider();
    const remove = new DeleteBranchUseCase(
      users,
      business,
      branches,
      pending,
      notifications,
    );

    const created = await create.execute(branch(), A, "adminA");
    await armed(pending, created.id, "adminA");
    sendCatalogChangedEvent.mockClear();

    await expect(
      remove.execute(created.id, A, "adminA", "000000"),
    ).rejects.toBeInstanceOf(BranchDeletionCodeInvalidError);

    expect(await branches.findBranchById(created.id)).not.toBeNull();
    expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
  });
});
