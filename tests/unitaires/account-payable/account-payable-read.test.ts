import { beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidV7 } from "uuid";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";

import { GetAccountPayableUseCase } from "@/modules/account-payable/usecases/get-account-payable/get-account-payable-usecase";

/**
 * GET /account-payable/:id (wave 3): the bill a notification opens in the
 * app. There was only the company list (behind account_payable_manage) and
 * "minhas contas" (the responsible's, no key). The read by id joins the two:
 * the office and the MASTER read the company's bills; anyone else, the
 * driver included, only a bill they answer for. Out of reach is the 404 of
 * an id that exists nowhere. The HTTP side is tests/E2E/app-reads-http.test.ts.
 */
const CARRIER = "018f3400-0000-7000-8000-00000000000a";
const OTHER = "018f3400-0000-7000-8000-00000000000b";

const ADMIN = "018f3400-0000-7000-8000-0000000000a1";
const MASTER = "018f3400-0000-7000-8000-0000000000a2";
const DRIVER_USER = "018f3400-0000-7000-8000-0000000000a3";
const COLLEAGUE_USER = "018f3400-0000-7000-8000-0000000000a4";
const READER = "018f3400-0000-7000-8000-0000000000a5";
const CLERK = "018f3400-0000-7000-8000-0000000000a6";
const OTHER_ADMIN = "018f3400-0000-7000-8000-0000000000a7";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let bills: InMemoryAccountPayableRepository;

const ids = { driver: "", colleague: "", clerk: "", foreign: "" };

async function bill(businessId: string, responsible: string): Promise<string> {
  return (
    await bills.createAccountPayable({
      businessId,
      branchId: "branch-1",
      registrationUserId: responsible,
      category: "FINES",
      due_date: new Date("2026-10-01T03:00:00.000Z"),
      amount: 293.47,
      amount_paid: 100,
      payee_name: "DETRAN",
      description: "Multa a descontar",
    })
  ).id;
}

beforeEach(async () => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  bills = new InMemoryAccountPayableRepository();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: "driver-1",
    } as User,
    {
      id: COLLEAGUE_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: "driver-2",
    } as User,
    {
      id: READER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      profileAccess: {
        name: "Financeiro",
        permissions: [
          {
            permissionKey: "account_payable_manage",
            canRead: true,
            canWrite: false,
          },
        ],
      },
    } as unknown as User,
    {
      id: CLERK,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      profileAccess: { name: "Pátio", permissions: [] },
    } as unknown as User,
    { id: OTHER_ADMIN, role: "BUSINESS_ADMIN", businessId: OTHER } as User,
  );
  businesses.business.push(
    { id: CARRIER, timezone: "America/Sao_Paulo" } as unknown as Business,
    { id: OTHER, timezone: "America/Sao_Paulo" } as unknown as Business,
  );

  ids.driver = await bill(CARRIER, DRIVER_USER);
  ids.colleague = await bill(CARRIER, COLLEAGUE_USER);
  ids.clerk = await bill(CARRIER, CLERK);
  ids.foreign = await bill(OTHER, OTHER_ADMIN);
});

const read = () => new GetAccountPayableUseCase(users, businesses, bills);

async function expectNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    statusCode: 404,
    code: "ACCOUNT_PAYABLE_NOT_FOUND",
  });
}

describe("GET /account-payable/:id", () => {
  it("gives the driver a bill he answers for, money as numbers, with the server's status", async () => {
    const answer = await read().execute({
      userId: DRIVER_USER,
      accountPayableId: ids.driver,
    });

    expect(answer).toMatchObject({
      id: ids.driver,
      registrationUserId: DRIVER_USER,
      amount: 293.47,
      amount_paid: 100,
      remaining_amount: 193.47,
      due_day: "2026-10-01",
      status_group: expect.any(String),
    });
  });

  it("answers a colleague's bill to the driver as missing", async () => {
    await expectNotFound(
      read().execute({ userId: DRIVER_USER, accountPayableId: ids.colleague }),
    );
  });

  it("lets a profile without the key read only the bills it answers for", async () => {
    const own = await read().execute({
      userId: CLERK,
      accountPayableId: ids.clerk,
    });

    expect(own.id).toBe(ids.clerk);

    await expectNotFound(
      read().execute({ userId: CLERK, accountPayableId: ids.driver }),
    );
  });

  it("gives a profile with account_payable_manage:read and the admin any bill of the company", async () => {
    for (const userId of [READER, ADMIN]) {
      const answer = await read().execute({
        userId,
        accountPayableId: ids.colleague,
      });

      expect(answer.id).toBe(ids.colleague);
    }
  });

  it("answers another company's bill and an unknown id as missing", async () => {
    await expectNotFound(
      read().execute({ userId: ADMIN, accountPayableId: ids.foreign }),
    );
    await expectNotFound(
      read().execute({ userId: ADMIN, accountPayableId: uuidV7() }),
    );
  });

  it("serves the MASTER the company he selected, and asks for one without it", async () => {
    const answer = await read().execute({
      userId: MASTER,
      accountPayableId: ids.foreign,
      businessId: OTHER,
    });

    expect(answer.id).toBe(ids.foreign);

    await expect(
      read().execute({ userId: MASTER, accountPayableId: ids.foreign }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    await expectNotFound(
      read().execute({
        userId: MASTER,
        accountPayableId: ids.foreign,
        businessId: CARRIER,
      }),
    );
  });

  it("refuses a company user naming another company (403 TENANT_ACCESS_DENIED)", async () => {
    await expect(
      read().execute({
        userId: DRIVER_USER,
        accountPayableId: ids.driver,
        businessId: OTHER,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("refuses a session user that no longer exists (404 USER_NOT_FOUND)", async () => {
    await expect(
      read().execute({ userId: uuidV7(), accountPayableId: ids.driver }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});
