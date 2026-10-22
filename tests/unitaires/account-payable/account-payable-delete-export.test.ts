import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { AccountPayable } from "@/modules/account-payable/dtos/account-payable-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";

import { DeleteAccountPayableUseCase } from "@/modules/account-payable/usecases/delete-account-payable/delete-account-payable-usecase";
import { ExportAccountPayableUseCase } from "@/modules/account-payable/usecases/export-account-payable/export-account-payable-usecase";
import { CreateAccountPayableUseCase } from "@/modules/account-payable/usecases/create-account-payable/create-account-payable-usecase";
import { UpdateAccountPayableUseCase } from "@/modules/account-payable/usecases/update-account-payable/update-account-payable-usecase";

/**
 * Deleting and exporting bills on the in-memory twins: who may, which
 * company, and what a paid bill or an empty report answers.
 */
const CARRIER = "018f2100-0000-7000-8000-00000000000a";
const OTHER = "018f2100-0000-7000-8000-00000000000b";

const ADMIN = "018f2100-0000-7000-8000-0000000000a1";
const FOREIGN_ADMIN = "018f2100-0000-7000-8000-0000000000a2";
const MASTER = "018f2100-0000-7000-8000-0000000000a3";

const BRANCH = "018f2100-0000-7000-8000-0000000000b1";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let bills: InMemoryAccountPayableRepository;
const notifications = { createActivityIfEnabled: vi.fn() };

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  bills = new InMemoryAccountPayableRepository();
  notifications.createActivityIfEnabled.mockClear();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: FOREIGN_ADMIN, role: "BUSINESS_ADMIN", businessId: OTHER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push(
    { id: CARRIER, timezone: "America/Sao_Paulo" } as unknown as Business,
    { id: OTHER, timezone: "America/Manaus" } as unknown as Business,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedBill(
  overrides: Partial<AccountPayable> = {},
): Promise<AccountPayable> {
  const created = await bills.createAccountPayable({
    businessId: CARRIER,
    branchId: BRANCH,
    registrationUserId: ADMIN,
    amount: 250,
    due_date: new Date("2026-10-10T03:00:00.000Z"),
    category: "TOLLS",
    payee_name: "Pedágio Anhanguera",
  } as never);

  Object.assign(created, overrides);

  return created;
}

const remove = () =>
  new DeleteAccountPayableUseCase(
    users,
    businesses,
    bills,
    notifications as never,
  );

const exporter = () =>
  new ExportAccountPayableUseCase(users, businesses, bills);

describe("DeleteAccountPayableUseCase", () => {
  it("deletes an unpaid bill of the company and records the activity", async () => {
    const bill = await seedBill();

    const deleted = await remove().execute(bill.id, CARRIER, ADMIN);

    expect(deleted.id).toBe(bill.id);
    expect(bills.accountPayables).toHaveLength(0);
    expect(notifications.createActivityIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete",
        entityId: bill.id,
        businessId: CARRIER,
      }),
    );
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    const bill = await seedBill();

    await expect(
      remove().execute(bill.id, CARRIER, "nobody"),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
    expect(bills.accountPayables).toHaveLength(1);
  });

  it("answers 404 BUSINESS_NOT_FOUND for an unknown company", async () => {
    const bill = await seedBill();

    await expect(
      remove().execute(bill.id, "018f2100-0000-7000-8000-0000000000ff", MASTER),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });

  it("answers 404 ACCOUNT_PAYABLE_NOT_FOUND for an unknown bill", async () => {
    await expect(
      remove().execute("018f2100-0000-7000-8000-0000000000fe", CARRIER, ADMIN),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "ACCOUNT_PAYABLE_NOT_FOUND",
    });
  });

  it("refuses a bill of another company named under this one (403), MASTER included", async () => {
    const bill = await seedBill();

    await expect(
      remove().execute(bill.id, OTHER, MASTER),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCOUNT_PAYABLE_TENANT_MISMATCH",
    });
    expect(bills.accountPayables).toHaveLength(1);
  });

  it("refuses a user of another company deleting this company's bill (403)", async () => {
    const bill = await seedBill();

    // The use case used to trust the route guard alone: a foreign admin
    // naming the bill's own company deleted it.
    await expect(
      remove().execute(bill.id, CARRIER, FOREIGN_ADMIN),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
    expect(bills.accountPayables).toHaveLength(1);
    expect(notifications.createActivityIfEnabled).not.toHaveBeenCalled();
  });

  it("refuses a paid bill with 409 ACCOUNT_PAYABLE_ALREADY_PAID", async () => {
    const bill = await seedBill({
      payment_date: new Date("2026-10-01T15:00:00.000Z"),
    });

    await expect(
      remove().execute(bill.id, CARRIER, ADMIN),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCOUNT_PAYABLE_ALREADY_PAID",
    });
    expect(bills.accountPayables).toHaveLength(1);
  });

  it("a second delete of the same bill answers 404, not a 500", async () => {
    const bill = await seedBill();

    await remove().execute(bill.id, CARRIER, ADMIN);

    await expect(
      remove().execute(bill.id, CARRIER, ADMIN),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "ACCOUNT_PAYABLE_NOT_FOUND",
    });
  });
});

async function drain(iterator: AsyncGenerator<Record<string, string>>) {
  const rows: Record<string, string>[] = [];

  for await (const row of iterator) rows.push(row);

  return rows;
}

describe("ExportAccountPayableUseCase", () => {
  it("exports the company's bills formatted in pt-BR, named by the company's day", async () => {
    // 02:00 UTC on the 6th is still the 5th in São Paulo.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T02:00:00.000Z"));

    await seedBill();
    // Another company's bill never reaches this report.
    const foreign = await seedBill();
    foreign.businessId = OTHER;

    const result = await exporter().execute({ userId: ADMIN });
    const rows = await drain(result.iterator);

    expect(result.filename).toBe("relatorio-contas-a-pagar-2026-10-05");
    expect(result.columns.map((column) => column.header)).toContain("Situação");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "Pendente",
      category: "Pedágio",
      payee: "Pedágio Anhanguera",
      due_day: "10/10/2026",
      payment_day: "N/A",
      vehicle: "N/A",
    });
    expect(rows[0].amount.replace(/\s/g, " ")).toBe("R$ 250,00");
  });

  it("refuses an empty report with 400 ACCOUNT_PAYABLE_NOTHING_TO_EXPORT", async () => {
    await expect(exporter().execute({ userId: ADMIN })).rejects.toMatchObject({
      statusCode: 400,
      code: "ACCOUNT_PAYABLE_NOTHING_TO_EXPORT",
    });
  });

  it("applies the list's search: no match is the empty report", async () => {
    await seedBill();

    await expect(
      exporter().execute({ userId: ADMIN, search: "inexistente" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_PAYABLE_NOTHING_TO_EXPORT" });
  });

  it("refuses another company's report (403 TENANT_ACCESS_DENIED)", async () => {
    await seedBill();

    await expect(
      exporter().execute({ userId: FOREIGN_ADMIN, businessId: CARRIER }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("asks the MASTER to pick a company (400 BUSINESS_NOT_IDENTIFIED)", async () => {
    await expect(exporter().execute({ userId: MASTER })).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });
  });

  it("lets the MASTER export the company it picked, and 404s an unknown one", async () => {
    await seedBill();

    const result = await exporter().execute({
      userId: MASTER,
      businessId: CARRIER,
    });
    expect(await drain(result.iterator)).toHaveLength(1);

    await expect(
      exporter().execute({
        userId: MASTER,
        businessId: "018f2100-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "TENANT_NOT_FOUND" });
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(
      exporter().execute({ userId: "nobody" }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});

describe("create and edit from another company", () => {
  // Nothing past the tenant check runs: the other twins are never reached.
  const unused = {} as never;

  it("refuses a create for a company the user does not belong to (403)", async () => {
    const create = new CreateAccountPayableUseCase(
      users,
      businesses,
      unused,
      unused,
      bills,
      unused,
      unused,
      unused,
    );

    await expect(
      create.execute(
        {
          businessId: CARRIER,
          branchId: BRANCH,
          registrationUserId: FOREIGN_ADMIN,
          amount: 100,
          due_date: "2026-10-10",
          payee_name: "Alguém",
        } as never,
        FOREIGN_ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    expect(bills.accountPayables).toHaveLength(0);
  });

  it("refuses an edit of this company's bill by a foreign user (403)", async () => {
    const bill = await seedBill();
    const update = new UpdateAccountPayableUseCase(
      users,
      businesses,
      unused,
      unused,
      bills,
      unused,
      unused,
      unused,
    );

    await expect(
      update.execute({ amount: 999 } as never, bill.id, CARRIER, FOREIGN_ADMIN),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    expect(bills.accountPayables[0].amount).toBe("250");
  });
});
