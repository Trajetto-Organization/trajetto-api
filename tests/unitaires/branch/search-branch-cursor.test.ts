import { beforeEach, describe, expect, it } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Branch } from "@/modules/branch/dtos/branch-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";

import { SearchBranchCursorUseCase } from "@/modules/branch/usecases/search-branch-cursor/search-branch-cursor-usecase";

/** The branch picker: one company's active branches, newest first, by cursor. */
const A = "018f3100-0000-7000-8000-00000000000a";
const B = "018f3100-0000-7000-8000-00000000000b";

const ADMIN_A = "018f3100-0000-7000-8000-0000000000a1";
const ADMIN_B = "018f3100-0000-7000-8000-0000000000b1";
const MASTER = "018f3100-0000-7000-8000-0000000000f1";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let branches: InMemoryBranchRepository;

const branch = (
  id: string,
  businessId: string,
  minute: number,
  extra: Partial<Branch> = {},
) =>
  ({
    id,
    businessId,
    corporate_reason: `Filial ${id}`,
    fantasy_name: null,
    cnpj: `0000000000${id.slice(-4)}`,
    city: "Campinas",
    uf: "SP",
    email: `${id}@exemplo.com.br`,
    is_active: true,
    created_at: new Date(Date.UTC(2026, 9, 1, 12, minute)),
    updated_at: new Date(Date.UTC(2026, 9, 1, 12, minute)),
    ...extra,
  }) as unknown as Branch;

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  branches = new InMemoryBranchRepository();

  users.user.push(
    { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: ADMIN_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push({ id: A } as Business, { id: B } as Business);

  branches.branches.push(
    branch("018f3100-0000-7000-8000-000000000001", A, 1),
    branch("018f3100-0000-7000-8000-000000000002", A, 2, { city: "Sorocaba" }),
    branch("018f3100-0000-7000-8000-000000000003", A, 3),
    // Same instant as …003: the id breaks the tie, as in Postgres.
    branch("018f3100-0000-7000-8000-000000000004", A, 3),
    branch("018f3100-0000-7000-8000-000000000005", A, 4, { is_active: false }),
    branch("018f3100-0000-7000-8000-000000000006", B, 5, { city: "Sorocaba" }),
  );
});

const search = () => new SearchBranchCursorUseCase(users, branches, businesses);

describe("SearchBranchCursorUseCase", () => {
  it("walks the company's active branches newest first, id breaking ties, no row twice", async () => {
    const first = await search().execute({
      userId: ADMIN_A,
      businessId: A,
      limit: 2,
    });

    expect(first.data.map((row) => row.id.slice(-1))).toEqual(["4", "3"]);
    expect(first.hasMore).toBe(true);

    const second = await search().execute({
      userId: ADMIN_A,
      businessId: A,
      limit: 2,
      cursor: first.nextCursor as string,
    });

    // The inactive branch and the other company's never show.
    expect(second.data.map((row) => row.id.slice(-1))).toEqual(["2", "1"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("searches case-insensitively inside the company only", async () => {
    const result = await search().execute({
      userId: ADMIN_A,
      businessId: A,
      search: "sorocaba",
    });

    expect(result.data.map((row) => row.id.slice(-1))).toEqual(["2"]);
  });

  it("answers an unknown cursor with nothing, not the first page again", async () => {
    const result = await search().execute({
      userId: ADMIN_A,
      businessId: A,
      cursor: "018f3100-0000-7000-8000-0000000000ff",
    });

    expect(result.data).toEqual([]);
  });

  it("refuses another company's branches (403 TENANT_ACCESS_DENIED)", async () => {
    await expect(
      search().execute({ userId: ADMIN_B, businessId: A }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
  });

  it("lets the MASTER search any company, and 404s an unknown one", async () => {
    const result = await search().execute({ userId: MASTER, businessId: B });
    expect(result.data).toHaveLength(1);

    await expect(
      search().execute({
        userId: MASTER,
        businessId: "018f3100-0000-7000-8000-0000000000fe",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(
      search().execute({ userId: "nobody", businessId: A }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});
