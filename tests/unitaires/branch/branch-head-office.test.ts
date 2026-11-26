import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCatalogChangedEvent = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({
  sendCatalogChangedEvent,
  announceSessionRevocation: vi.fn(),
}));

const sendTransactionalMail = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail,
}));

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { UpdateBranchUseCase } from "@/modules/branch/usecases/update-branch/update-branch-usecase";
import { ListBranchUseCase } from "@/modules/branch/usecases/list-branch/list-branch-usecase";
import { DeleteBranchUseCase } from "@/modules/branch/usecases/delete-branch/delete-branch-usecase";
import { RequestBranchDeletionUseCase } from "@/modules/branch/usecases/request-branch-deletion/request-branch-deletion-usecase";
import { ToggleBranchActiveUseCase } from "@/modules/branch/usecases/toggle-branch-active/toggle-branch-active-usecase";
import { InMemoryPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/in-memory/in-memory-pending-deletion-provider";
import { hashSecret } from "@/shared/security/bcrypt-gate";
import { HEAD_OFFICE_MIRRORED_FIELDS } from "@/modules/branch/branch-head-office";
import { updateBranchSchema } from "@/schemas/update-branch-schema";
import { updateBusinessSchema } from "@/schemas/update-business-schema";

import type { Branch } from "@/modules/branch/dtos/branch-dto";

/**
 * The head office is a one-way copy of the company (audit of 11/2026).
 *
 * The company finds its head office by CNPJ and rewrites it on every save
 * in Empresas (UpdateBusinessUseCase). Filiais edited it freely and never
 * synced back: an edit there was silently undone by the next company save,
 * and a CNPJ changed there unlinked it for good. Now Filiais refuses to
 * change it, and the list tells the screen which row it is.
 */
const A = "018fec00-0000-7000-8000-00000000000a";
const COMPANY_CNPJ = "11111111000111";

const HEAD_OFFICE = "018fec00-0000-7000-8000-0000000000b1";
const CAMPINAS = "018fec00-0000-7000-8000-0000000000b2";

const B = "018fec00-0000-7000-8000-00000000000b";
const OTHER_CNPJ = "22222222000122";
const OTHER_HEAD_OFFICE = "018fec00-0000-7000-8000-0000000000c1";

const people: Record<string, { role: string; businessId: string | null }> = {
  adminA: { role: "BUSINESS_ADMIN", businessId: A },
  adminB: { role: "BUSINESS_ADMIN", businessId: B },
  master: { role: "MASTER", businessId: null },
};

const users = {
  findUserById: async (id: string) =>
    people[id]
      ? { id, ...people[id], name: id, email: `${id}@example.com` }
      : null,
  findBusinessAdminsByBusinessId: async () => [],
} as never;

const company = {
  id: A,
  corporate_reason: "Transportadora A",
  cnpj: COMPANY_CNPJ,
  email: "contato@example.com",
};

const otherCompany = {
  id: B,
  corporate_reason: "Transportadora B",
  cnpj: OTHER_CNPJ,
  email: "contato-b@example.com",
};

const companies = [company, otherCompany];

const business = {
  findBusinessById: async (id: string) =>
    companies.find((entry) => entry.id === id) ?? null,
  findBusinessByCnpj: async (cnpj: string) =>
    companies.find((entry) => entry.cnpj === cnpj) ?? null,
} as never;

const createActivityIfEnabled = vi.fn();
const notifications = { createActivityIfEnabled } as never;

let branches: InMemoryBranchRepository;

const row = (overrides: Partial<Branch>): Branch => ({
  id: CAMPINAS,
  corporate_reason: "Filial Campinas",
  fantasy_name: null,
  cep: "13010000",
  city: "Campinas",
  uf: "SP",
  street: "Rua Um",
  address_number: "10",
  cnpj: "33333333000133",
  complement: null,
  cnae: "4930202",
  erp_code: "002",
  responsible_name: "Bruno",
  telephone: "19999999999",
  email: "campinas@example.com",
  is_active: true,
  businessId: A,
  created_at: new Date("2026-09-01T12:00:00Z"),
  updated_at: new Date("2026-09-01T12:00:00Z"),
  ...overrides,
});

beforeEach(() => {
  branches = new InMemoryBranchRepository();
  branches.branches.push(
    row({
      id: HEAD_OFFICE,
      corporate_reason: "Transportadora A",
      cnpj: COMPANY_CNPJ,
      erp_code: "001",
      email: "contato@example.com",
      created_at: new Date("2026-08-01T12:00:00Z"),
    }),
    row({}),
    row({
      id: OTHER_HEAD_OFFICE,
      corporate_reason: "Transportadora B",
      cnpj: OTHER_CNPJ,
      erp_code: "001",
      email: "contato-b@example.com",
      businessId: B,
    }),
  );
  sendCatalogChangedEvent.mockClear();
  sendTransactionalMail.mockClear();
  createActivityIfEnabled.mockClear();
});

const update = () =>
  new UpdateBranchUseCase(users, business, branches, notifications);

const headOffice = () =>
  branches.branches.find((branch) => branch.id === HEAD_OFFICE)!;

describe("the head office in Filiais", () => {
  it.each([
    ["its trade name", { fantasy_name: "Matriz SP" }],
    ["its e-mail", { email: "outro@example.com" }],
    ["its address", { street: "Rua Dois", address_number: "20" }],
    // The CNPJ is the link itself: changed here, the company lost it.
    ["its CNPJ", { cnpj: "44444444000144" }],
  ])("refuses to change %s, pointing to Empresas", async (_what, edit) => {
    await expect(
      update().execute(edit, HEAD_OFFICE, A, "adminA"),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "BRANCH_HEAD_OFFICE_READ_ONLY",
      message: expect.stringContaining("Empresas"),
    });

    expect(headOffice()).toMatchObject({
      fantasy_name: null,
      email: "contato@example.com",
      street: "Rua Um",
      cnpj: COMPANY_CNPJ,
    });
    expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
  });

  it("is no refusal when the form comes back with the values it already has", async () => {
    const { id: _id, is_active: _active, ...current } = headOffice();

    await expect(
      update().execute(
        {
          ...current,
          // The web posts an empty optional field as "" or null.
          fantasy_name: "",
          complement: null,
        },
        HEAD_OFFICE,
        A,
        "adminA",
      ),
    ).resolves.toMatchObject({ id: HEAD_OFFICE, cnpj: COMPANY_CNPJ });
  });

  it("leaves every other branch editable", async () => {
    await expect(
      update().execute(
        { fantasy_name: "Campinas Centro", cnpj: "55555555000155" },
        CAMPINAS,
        A,
        "adminA",
      ),
    ).resolves.toMatchObject({
      fantasy_name: "Campinas Centro",
      cnpj: "55555555000155",
    });
  });

  it("is marked on the list rows, so the screen shows it read-only", async () => {
    const list = new ListBranchUseCase(users, branches, business);
    const { data } = await list.execute({
      userId: "adminA",
      page: 1,
      pageSize: 10,
    });

    expect(
      Object.fromEntries(data.map((entry) => [entry.id, entry.is_head_office])),
    ).toEqual({ [HEAD_OFFICE]: true, [CAMPINAS]: false });
  });
});

/**
 * The head office cannot be deleted (owner decision of 26/11/2026).
 *
 * Deleting it left the company with no head office and no warning: the
 * saves in Empresas stopped mirroring onto it, and a branch created later
 * with the company's CNPJ silently became the "new" head office. Both steps
 * refuse it before any side effect (no code is stored or mailed, nothing
 * is deleted), after the tenant check, so another company's head office is
 * still the 404 of a missing branch. Deactivating it stays allowed: that
 * can be undone.
 */
describe("deleting the head office", () => {
  const CODE = "123456";

  const pending = () => new InMemoryPendingDeletionProvider();

  const request = (deletions: InMemoryPendingDeletionProvider) =>
    new RequestBranchDeletionUseCase(users, business, branches, deletions);

  const remove = (deletions: InMemoryPendingDeletionProvider) =>
    new DeleteBranchUseCase(
      users,
      business,
      branches,
      deletions,
      notifications,
    );

  const armed = async (
    deletions: InMemoryPendingDeletionProvider,
    branchId: string,
    userId: string,
  ) =>
    deletions.upsertPendingDeletion({
      entity_type: "branch",
      entity_id: branchId,
      userId,
      code_hash: await hashSecret(CODE, 4),
      expires: new Date(Date.now() + 60_000),
    });

  const refusal = {
    statusCode: 409,
    code: "BRANCH_HEAD_OFFICE_NOT_DELETABLE",
    message: expect.stringContaining("Empresas"),
  };

  it.each(["adminA", "master"])(
    "refuses to send the deletion code for it, to %s, storing nothing",
    async (userId) => {
      const deletions = pending();

      await expect(
        request(deletions).execute(HEAD_OFFICE, A, userId),
      ).rejects.toMatchObject(refusal);

      expect(deletions.pendingDeletions).toHaveLength(0);
      expect(sendTransactionalMail).not.toHaveBeenCalled();
    },
  );

  it.each(["adminA", "master"])(
    "refuses to delete it with a valid code, to %s, and it stays",
    async (userId) => {
      const deletions = pending();
      await armed(deletions, HEAD_OFFICE, userId);

      await expect(
        remove(deletions).execute(HEAD_OFFICE, A, userId, CODE),
      ).rejects.toMatchObject(refusal);

      expect(headOffice()).toMatchObject({ cnpj: COMPANY_CNPJ });
      expect(sendCatalogChangedEvent).not.toHaveBeenCalled();
      expect(createActivityIfEnabled).not.toHaveBeenCalled();
    },
  );

  it("answers another company's head office like a missing branch, on both steps", async () => {
    const deletions = pending();
    await armed(deletions, OTHER_HEAD_OFFICE, "adminA");

    await expect(
      request(deletions).execute(OTHER_HEAD_OFFICE, A, "adminA"),
    ).rejects.toMatchObject({ statusCode: 404, code: "BRANCH_NOT_FOUND" });
    await expect(
      remove(deletions).execute(OTHER_HEAD_OFFICE, A, "adminA", CODE),
    ).rejects.toMatchObject({ statusCode: 404, code: "BRANCH_NOT_FOUND" });

    expect(
      branches.branches.some((entry) => entry.id === OTHER_HEAD_OFFICE),
    ).toBe(true);
  });

  it("still deletes any other branch of the company", async () => {
    const deletions = pending();

    await request(deletions).execute(CAMPINAS, A, "adminA");
    await armed(deletions, CAMPINAS, "adminA");
    await remove(deletions).execute(CAMPINAS, A, "adminA", CODE);

    expect(await branches.findBranchById(CAMPINAS)).toBeNull();
    expect(headOffice()).toBeDefined();
  });

  it("still lets it be deactivated and reactivated", async () => {
    const toggle = new ToggleBranchActiveUseCase(
      users,
      business,
      branches,
      notifications,
      new InMemoryDriverRepository(),
    );

    await expect(
      toggle.execute(HEAD_OFFICE, A, "adminA"),
    ).resolves.toMatchObject({ id: HEAD_OFFICE, is_active: false });
    await expect(
      toggle.execute(HEAD_OFFICE, A, "adminA"),
    ).resolves.toMatchObject({ id: HEAD_OFFICE, is_active: true });
  });
});

/**
 * The class of bug: a field the company writes onto its head office that
 * Filiais could still change would be silently undone again. Every field
 * both bodies carry is on the mirrored list, and so is every field the
 * branch edit accepts (a branch-only field would need its own decision).
 */
describe("the mirrored fields", () => {
  const keysOf = (shape: Record<string, unknown>, except: string[]) =>
    Object.keys(shape)
      .filter((key) => !except.includes(key))
      .sort();

  it("cover every field the branch edit accepts", () => {
    expect(keysOf(updateBranchSchema.shape, ["businessId"])).toEqual(
      [...HEAD_OFFICE_MIRRORED_FIELDS].sort(),
    );
  });

  it("cover every field the company writes onto its head office", () => {
    expect(
      keysOf(updateBusinessSchema.shape, ["businessId", "timezone"]),
    ).toEqual([...HEAD_OFFICE_MIRRORED_FIELDS].sort());
  });
});
