import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

const tx = vi.hoisted(() => ({
  current: {
    $transaction: async (run: (client: unknown) => Promise<unknown>) => run({}),
  },
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: (run: (client: unknown) => Promise<unknown>) =>
      tx.current.$transaction(run),
  },
}));

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateBusinessProps } from "@/modules/business/dtos/business-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { inMemoryTransaction } from "@/shared/in-memory/in-memory-transaction";

import { CreateBusinessUseCase } from "@/modules/business/usecases/create-business/create-business-usecase";
import { UpdateBusinessUseCase } from "@/modules/business/usecases/update-business/update-business-usecase";

/**
 * A company and its head office are one fact. They were two writes: when the
 * head office failed (a branch CNPJ taken by a racing request, a dropped
 * connection) the company stayed, without a head office, and the MASTER got
 * a 500 — then a 409 "CNPJ já cadastrado" on the retry, for a company that
 * looked half there.
 */
const MASTER = "018f3300-0000-7000-8000-0000000000f1";

const company = (): CreateBusinessProps => ({
  corporate_reason: "Transportadora Beta Ltda",
  fantasy_name: "Beta",
  cep: "13010000",
  city: "Campinas",
  uf: "SP",
  street: "Rua Dois",
  address_number: "20",
  cnpj: "33333333000133",
  complement: "",
  cnae: "4930202",
  erp_code: "BETA",
  responsible_name: "Bia Lima",
  telephone: "19999990001",
  email: "contato@beta.com.br",
  timezone: "America/Sao_Paulo",
});

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let branches: InMemoryBranchRepository;
const notifications = { createActivityIfEnabled: vi.fn(async () => undefined) };

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  branches = new InMemoryBranchRepository();
  notifications.createActivityIfEnabled.mockClear();

  users.user.push({
    id: MASTER,
    role: "MASTER",
    businessId: null,
  } as unknown as User);

  tx.current = inMemoryTransaction([businesses, branches]);
});

const create = () =>
  new CreateBusinessUseCase(
    users,
    businesses,
    branches,
    notifications as never,
  );

describe("creating a company with its head office", () => {
  it("writes neither when the head office loses a uniqueness race, and answers the branch's 409", async () => {
    branches.createBranch = async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`cnpj`)",
        {
          code: "P2002",
          clientVersion: "in-memory",
          meta: { target: ["cnpj"] },
        },
      );
    };

    await expect(create().execute(company(), MASTER)).rejects.toMatchObject({
      statusCode: 409,
      code: "BRANCH_CNPJ_UNAVAILABLE",
    });

    expect(businesses.business).toEqual([]);
    expect(notifications.createActivityIfEnabled).not.toHaveBeenCalled();
  });

  it("writes neither when the head office write fails for any other reason (500)", async () => {
    branches.createBranch = async () => {
      throw new Error("connection reset");
    };

    await expect(create().execute(company(), MASTER)).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(businesses.business).toEqual([]);
  });

  it("still writes both together on the happy path", async () => {
    const created = await create().execute(company(), MASTER);

    expect(businesses.business.map((row) => row.id)).toEqual([created.id]);
    expect(branches.branches).toMatchObject([
      { businessId: created.id, cnpj: "33333333000133" },
    ]);
  });
});

describe("updating a company and its head office", () => {
  it("keeps the company's old values when the head office loses a uniqueness race (409)", async () => {
    // Red before: the company row was already updated when the head office
    // write failed — a 409 for a change that had half happened.
    const created = await create().execute(company(), MASTER);

    branches.updateBranch = async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`email`)",
        {
          code: "P2002",
          clientVersion: "in-memory",
          meta: { target: ["email"] },
        },
      );
    };

    const update = new UpdateBusinessUseCase(
      users,
      businesses,
      branches,
      notifications as never,
    );

    await expect(
      update.execute({
        businessId: created.id as string,
        userId: MASTER,
        businessData: { fantasy_name: "Beta Nova", email: "novo@beta.com.br" },
      } as never),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(businesses.business[0]).toMatchObject({
      fantasy_name: "Beta",
      email: "contato@beta.com.br",
    });
  });
});
