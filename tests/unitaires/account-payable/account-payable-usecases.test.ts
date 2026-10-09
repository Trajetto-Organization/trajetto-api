import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import type { Vehicle } from "@/modules/vehicle/dtos/vehicle-dto";
import type { ServiceOrder } from "@/modules/service-order/dtos/service-order-dto";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";

import { CreateAccountPayableUseCase } from "@/modules/account-payable/usecases/create-account-payable/create-account-payable-usecase";
import { UpdateAccountPayableUseCase } from "@/modules/account-payable/usecases/update-account-payable/update-account-payable-usecase";
import { SearchAccountPayableCursorUseCase } from "@/modules/account-payable/usecases/search-account-payable-cursor/search-account-payable-cursor-usecase";
import { ListAccountPayableUseCase } from "@/modules/account-payable/usecases/list-account-payable/list-account-payable-usecase";

/**
 * Accounts payable rules on the in-memory twins (the HTTP and SQL side is in
 * tests/E2E/account-payable-http.test.ts). The transaction is the only
 * thing replaced: the twins have no database to open one on.
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const CARRIER = "018f2000-0000-7000-8000-00000000000a";
const OTHER = "018f2000-0000-7000-8000-00000000000b";

const ADMIN = "018f2000-0000-7000-8000-0000000000a1";
const CLERK = "018f2000-0000-7000-8000-0000000000a2";
const DRIVER_USER = "018f2000-0000-7000-8000-0000000000a3";
const MASTER = "018f2000-0000-7000-8000-0000000000a4";

const BRANCH = "018f2000-0000-7000-8000-0000000000b1";
const SUPPLIER = "018f2000-0000-7000-8000-0000000000c1";
const FOREIGN_SUPPLIER = "018f2000-0000-7000-8000-0000000000c2";
const VEHICLE = "018f2000-0000-7000-8000-0000000000e1";
const FOREIGN_VEHICLE = "018f2000-0000-7000-8000-0000000000e2";
const ORDER = "018f2000-0000-7000-8000-0000000000f1";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let branches: InMemoryBranchRepository;
let orders: InMemoryServiceOrderRepository;
let suppliers: InMemorySupplierRepository;
let vehicles: InMemoryVehicleRepository;
let bills: InMemoryAccountPayableRepository;

const outbox = {
  publish: vi.fn(async () => undefined),
} as unknown as OutboxService;

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  branches = new InMemoryBranchRepository();
  orders = new InMemoryServiceOrderRepository();
  suppliers = new InMemorySupplierRepository();
  vehicles = new InMemoryVehicleRepository();
  bills = new InMemoryAccountPayableRepository();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: CLERK, role: "BUSINESS_USER", businessId: CARRIER } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: "driver-1",
    } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push(
    { id: CARRIER, timezone: "America/Sao_Paulo" } as unknown as Business,
    { id: OTHER, timezone: "America/Manaus" } as unknown as Business,
  );
  branches.branches.push({ id: BRANCH, businessId: CARRIER } as Branch);
  suppliers.suppliers.push(
    { id: SUPPLIER, name: "Oficina Central", businessId: CARRIER } as never,
    { id: FOREIGN_SUPPLIER, name: "Oficina Alheia", businessId: OTHER } as never,
  );
  vehicles.vehicles.push(
    { id: VEHICLE, license_plate: "ABC1D23", businessId: CARRIER } as Vehicle,
    { id: FOREIGN_VEHICLE, license_plate: "XYZ9K88", businessId: OTHER } as Vehicle,
  );
  orders.serviceOrders.push({
    id: ORDER,
    businessId: CARRIER,
    total_amount: "1000.00",
  } as unknown as ServiceOrder);
});

const create = () =>
  new CreateAccountPayableUseCase(
    users,
    businesses,
    branches,
    orders,
    bills,
    outbox,
    suppliers,
    vehicles,
  );

const update = () =>
  new UpdateAccountPayableUseCase(
    users,
    businesses,
    branches,
    orders,
    bills,
    outbox,
    suppliers,
    vehicles,
  );

const bill = (overrides: Record<string, unknown> = {}) => ({
  category: "MAINTENANCE" as const,
  due_date: "2026-10-01",
  amount: 600,
  businessId: CARRIER,
  branchId: BRANCH,
  registrationUserId: CLERK,
  supplierId: SUPPLIER,
  vehicleId: VEHICLE,
  description: "Troca de embreagem\n\nPeças e mão de obra",
  document_number: "NF 4512",
  ...overrides,
});

describe("what a bill records (decision 8.4)", () => {
  it("keeps payee, cost centre, description, document and who registered it", async () => {
    const created = await create().execute(bill(), ADMIN);

    expect(bills.accountPayables[0]).toMatchObject({
      id: created.id,
      supplierId: SUPPLIER,
      payee_name: null,
      vehicleId: VEHICLE,
      description: "Troca de embreagem\n\nPeças e mão de obra",
      document_number: "NF 4512",
      // The session user, not the responsible chosen in the form.
      createdById: ADMIN,
      registrationUserId: CLERK,
    });
  });

  it("stores the picked due DAY as the start of that day in the company's zone", async () => {
    await create().execute(bill({ due_date: "2026-10-01" }), ADMIN);

    expect(new Date(bills.accountPayables[0].due_date).toISOString()).toBe(
      "2026-10-01T03:00:00.000Z",
    );
  });

  it("refuses a supplier or a vehicle of another company, saying only 'not in this company'", async () => {
    await expect(
      create().execute(bill({ supplierId: FOREIGN_SUPPLIER }), ADMIN),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "ACCOUNT_PAYABLE_INVALID_REFERENCE",
      message: "Fornecedor não encontrado nesta empresa.",
    });

    await expect(
      create().execute(bill({ vehicleId: FOREIGN_VEHICLE }), ADMIN),
    ).rejects.toMatchObject({
      message: "Veículo não encontrado nesta empresa.",
    });

    expect(bills.accountPayables).toHaveLength(0);
  });

  it("drops a free-text payee when a supplier is named", async () => {
    await create().execute(bill({ payee_name: "Texto solto" }), ADMIN);

    expect(bills.accountPayables[0].payee_name).toBeNull();
  });
});

describe("bills above their service order's total (FLEET-AP-5)", () => {
  it("are saved, with a warning", async () => {
    await create().execute(bill({ serviceOrderId: ORDER, amount: 600 }), ADMIN);
    const second = await create().execute(
      bill({ serviceOrderId: ORDER, amount: 500 }),
      ADMIN,
    );

    expect(bills.accountPayables).toHaveLength(2);
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toContain("acima do total da ordem");
  });
});

describe("an edit", () => {
  it("never moves a bill to another company, not even for the MASTER", async () => {
    const created = await create().execute(bill(), ADMIN);

    // The old update skipped the check for the MASTER and wrote the path's
    // businessId into the row.
    await expect(
      update().execute({ amount: 700 }, created.id, OTHER, MASTER),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCOUNT_PAYABLE_TENANT_MISMATCH",
    });

    expect(bills.accountPayables[0]).toMatchObject({
      businessId: CARRIER,
      amount: "600",
    });
  });

  it("keeps the responsible when the edit does not name one", async () => {
    const created = await create().execute(bill(), ADMIN);

    // The old use case filled an absent responsible with whoever saved the
    // form — handing the bill over (and notifying) on an unrelated edit.
    await update().execute({ document_number: "NF 4513" }, created.id, CARRIER, ADMIN);

    expect(bills.accountPayables[0]).toMatchObject({
      registrationUserId: CLERK,
      document_number: "NF 4513",
    });
  });

  it("switches the payee cleanly between supplier and free text", async () => {
    const created = await create().execute(bill(), ADMIN);

    await update().execute(
      { payee_name: "Pedágio Anhanguera" },
      created.id,
      CARRIER,
      ADMIN,
    );

    expect(bills.accountPayables[0]).toMatchObject({
      supplierId: null,
      payee_name: "Pedágio Anhanguera",
    });
  });

  it("refuses to leave a bill that names a payee without one", async () => {
    const created = await create().execute(bill(), ADMIN);

    // Sending the supplier as null, alone, used to clear it: the bill ended
    // with neither supplier nor name, which the create refuses.
    await expect(
      update().execute(
        { supplierId: null, payee_name: null },
        created.id,
        CARRIER,
        ADMIN,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "ACCOUNT_PAYABLE_PAYEE_REQUIRED",
    });

    expect(bills.accountPayables[0]).toMatchObject({
      supplierId: SUPPLIER,
      payee_name: null,
    });
  });

  it("lets a legacy bill without a payee be edited without inventing one", async () => {
    const created = await create().execute(bill(), ADMIN);

    // What rows from before decision 8.4 look like.
    Object.assign(bills.accountPayables[0], { supplierId: null, payee_name: null });

    await update().execute(
      { supplierId: null, payee_name: null, amount_paid: 600, payment_date: "2026-10-01" },
      created.id,
      CARRIER,
      ADMIN,
    );

    expect(bills.accountPayables[0]).toMatchObject({
      supplierId: null,
      payee_name: null,
      amount_paid: "600",
    });
  });
});

describe("'minhas contas a pagar' (decision 4.5)", () => {
  it("gives a driver the bills they answer for, with the server's status", async () => {
    await create().execute(bill({ registrationUserId: DRIVER_USER }), ADMIN);
    await create().execute(bill({ registrationUserId: CLERK }), ADMIN);

    const result = await new SearchAccountPayableCursorUseCase(
      users,
      businesses,
      bills,
    ).execute({ userId: DRIVER_USER, limit: 10 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      registrationUserId: DRIVER_USER,
      status_group: expect.any(String),
      due_day: "2026-10-01",
    });
  });

  it("gives the MASTER, who answers for no bill, an empty list", async () => {
    const result = await new SearchAccountPayableCursorUseCase(
      users,
      businesses,
      bills,
    ).execute({ userId: MASTER });

    expect(result).toEqual({ data: [], nextCursor: null, hasMore: false });
  });
});

describe("the list", () => {
  it("decides the status by the company's day, on the server", async () => {
    // Due yesterday, today and tomorrow in São Paulo.
    const today = new Date();
    const key = (offset: number) =>
      new Date(today.getTime() + offset * 86_400_000)
        .toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

    await create().execute(bill({ due_date: key(-1) }), ADMIN);
    await create().execute(bill({ due_date: key(0) }), ADMIN);
    await create().execute(bill({ due_date: key(1) }), ADMIN);

    const result = await new ListAccountPayableUseCase(
      users,
      businesses,
      bills,
    ).execute({ userId: ADMIN, page: 1, pageSize: 10, sort: "due_date", order: "asc" });

    expect(result.data.map((row) => row.status)).toEqual([
      "OVERDUE",
      "PENDING", // due today: not overdue yet
      "PENDING",
    ]);
    expect(result.searchMeta).toMatchObject({ total: 3, open: 2, overdue: 1, paid: 0 });
  });
});
