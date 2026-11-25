import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCatalogChangedEvent = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({
  sendCatalogChangedEvent,
  announceSessionRevocation: vi.fn(),
}));

import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { UpdateBranchUseCase } from "@/modules/branch/usecases/update-branch/update-branch-usecase";
import { ListBranchUseCase } from "@/modules/branch/usecases/list-branch/list-branch-usecase";
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

const users = {
  findUserById: async (id: string) =>
    id === "adminA"
      ? { id, role: "BUSINESS_ADMIN", businessId: A, name: "Ana" }
      : null,
} as never;

const company = {
  id: A,
  corporate_reason: "Transportadora A",
  cnpj: COMPANY_CNPJ,
  email: "contato@example.com",
};

const business = {
  findBusinessById: async (id: string) => (id === A ? company : null),
  findBusinessByCnpj: async (cnpj: string) =>
    cnpj === COMPANY_CNPJ ? company : null,
} as never;

const notifications = { createActivityIfEnabled: vi.fn() } as never;

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
  );
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
