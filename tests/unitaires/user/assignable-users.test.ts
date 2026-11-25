import "reflect-metadata";

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Branch } from "@/modules/branch/dtos/branch-dto";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBranchRepository } from "@/modules/branch/repositories/in-memory/in-memory-branch-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";
import { InMemoryVehicleRepository } from "@/modules/vehicle/repositories/in-memory/in-memory-vehicle-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";
import { InMemoryKanbanRepository } from "@/modules/kanban/repositories/in-memory/in-memory-kanban-repository";

import { SearchUserCursorUseCase } from "@/modules/user/usecases/search-user-cursor/search-user-cursor-usecase";
import { CreateAccountPayableUseCase } from "@/modules/account-payable/usecases/create-account-payable/create-account-payable-usecase";
import { UpdateAccountPayableUseCase } from "@/modules/account-payable/usecases/update-account-payable/update-account-payable-usecase";
import { CreateKanbanColumnUseCase } from "@/modules/kanban/usecases/create-column/create-column-usecase";
import { CreateKanbanCardUseCase } from "@/modules/kanban/usecases/create-card/create-card-usecase";
import { UpdateKanbanCardUseCase } from "@/modules/kanban/usecases/update-card/update-card-usecase";
import { CreateServiceOrderUseCase } from "@/modules/service-order/usecases/create-service-order/create-service-order-usecase";
import { UpdateServiceOrderUseCase } from "@/modules/service-order/usecases/update-service-order/update-service-order-usecase";
import { assertResponsibleUser } from "@/modules/vehicle/usecases/vehicle-responsible";

/**
 * Audit of 11/2026: the user picker (GET /user/search-user-business) listed
 * revoked logins and "Usuário removido" (the anonymized row the removal job
 * keeps), and every save that names a responsible or an assignee accepted
 * them — so a bill's notices went to a login nobody could open.
 *
 * The picker hides them, and each save refuses a NEW choice of one with
 * USER_NOT_ASSIGNABLE, while a record that already names one stays
 * editable (history keeps showing who answered for it).
 */
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

const CARRIER = "018f2600-0000-7000-8000-00000000000a";
const OTHER = "018f2600-0000-7000-8000-00000000000b";

const ADMIN = "018f2600-0000-7000-8000-0000000000a1";
const ACTIVE = "018f2600-0000-7000-8000-0000000000a2";
const REVOKED = "018f2600-0000-7000-8000-0000000000a3";
const REMOVED = "018f2600-0000-7000-8000-0000000000a4";
const FOREIGN_REVOKED = "018f2600-0000-7000-8000-0000000000a5";

const BRANCH = "018f2600-0000-7000-8000-0000000000b1";
const VEHICLE = "018f2600-0000-7000-8000-0000000000e1";

const NOT_ASSIGNABLE = { statusCode: 400, code: "USER_NOT_ASSIGNABLE" };

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let branches: InMemoryBranchRepository;
let orders: InMemoryServiceOrderRepository;
let suppliers: InMemorySupplierRepository;
let vehicles: InMemoryVehicleRepository;
let bills: InMemoryAccountPayableRepository;
let board: InMemoryKanbanRepository;

const outbox = {
  publish: vi.fn(async () => undefined),
} as unknown as OutboxService;

const person = (overrides: Partial<User> & { created_at?: Date }) =>
  ({
    password: "x",
    role: "BUSINESS_USER",
    access_revoked: false,
    anonymized_at: null,
    businessId: CARRIER,
    created_at: new Date("2026-09-01T12:00:00Z"),
    ...overrides,
  }) as User;

/** Lets a person lose their access after a record already names them. */
function revoke(userId: string) {
  const user = users.user.find((row) => row.id === userId)!;

  user.access_revoked = true;
}

/** The error code a call ends with, or "OK" when it resolves. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();

    return "OK";
  } catch (error) {
    return (error as { code?: string }).code ?? "UNCODED";
  }
}

beforeEach(() => {
  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  branches = new InMemoryBranchRepository();
  orders = new InMemoryServiceOrderRepository();
  suppliers = new InMemorySupplierRepository();
  vehicles = new InMemoryVehicleRepository();
  bills = new InMemoryAccountPayableRepository();
  board = new InMemoryKanbanRepository();

  users.user.push(
    person({
      id: ADMIN,
      name: "Gestora",
      email: "gestora@example.com",
      role: "BUSINESS_ADMIN",
    }),
    person({
      id: ACTIVE,
      name: "Carla Ativa",
      email: "carla@example.com",
      created_at: new Date("2026-09-02T12:00:00Z"),
    }),
    person({
      id: REVOKED,
      name: "Carlos Revogado",
      email: "carlos@example.com",
      access_revoked: true,
      created_at: new Date("2026-09-03T12:00:00Z"),
    }),
    // What the USER_ANONYMIZE job leaves: anonymous name, no e-mail.
    person({
      id: REMOVED,
      name: "Usuário removido",
      email: null,
      access_revoked: true,
      anonymized_at: new Date("2026-10-01T12:00:00Z"),
      created_at: new Date("2026-09-04T12:00:00Z"),
    }),
    person({
      id: FOREIGN_REVOKED,
      name: "Outra Empresa",
      email: "outra@example.com",
      businessId: OTHER,
      access_revoked: true,
    }),
  );
  businesses.business.push(
    {
      id: CARRIER,
      corporate_reason: "Transportadora",
      timezone: "America/Sao_Paulo",
    } as unknown as Business,
    { id: OTHER, timezone: "America/Manaus" } as unknown as Business,
  );
  branches.branches.push({ id: BRANCH, businessId: CARRIER } as Branch);
  vehicles.vehicles.push({
    id: VEHICLE,
    license_plate: "ABC1D23",
    businessId: CARRIER,
    mileage: 1000,
  } as never);

  for (const user of users.user) {
    board.users.set(user.id, {
      id: user.id,
      name: user.name,
      email: user.email ?? "",
      avatar: null,
    });
  }
});

describe("the user picker (GET /user/search-user-business)", () => {
  it("offers only people who can still sign in", async () => {
    const result = await new SearchUserCursorUseCase(
      users,
      businesses,
    ).execute({ userId: ADMIN, businessId: CARRIER, limit: 50 });

    expect(result.data.map((row) => row.id)).toEqual([ACTIVE, ADMIN]);
  });

  it("does not bring a revoked login back through the search term", async () => {
    const result = await new SearchUserCursorUseCase(
      users,
      businesses,
    ).execute({ userId: ADMIN, businessId: CARRIER, search: "carl" });

    expect(result.data.map((row) => row.id)).toEqual([ACTIVE]);
  });
});

describe("a bill's responsible", () => {
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

  const bill = (registrationUserId: string) => ({
    category: "MAINTENANCE" as const,
    due_date: "2026-10-01",
    amount: 600,
    businessId: CARRIER,
    branchId: BRANCH,
    registrationUserId,
    payee_name: "Oficina",
  });

  it("is never a revoked or removed login", async () => {
    for (const responsible of [REVOKED, REMOVED]) {
      await expect(
        create().execute(bill(responsible), ADMIN),
      ).rejects.toMatchObject(NOT_ASSIGNABLE);
    }

    const created = await create().execute(bill(ACTIVE), ADMIN);

    await expect(
      update().execute(
        { registrationUserId: REVOKED },
        created.id,
        CARRIER,
        ADMIN,
      ),
    ).rejects.toMatchObject(NOT_ASSIGNABLE);
    expect(bills.accountPayables[0].registrationUserId).toBe(ACTIVE);
  });

  it("still says only 'not in this company' for another company's revoked user", async () => {
    await expect(
      create().execute(bill(FOREIGN_REVOKED), ADMIN),
    ).rejects.toMatchObject({ code: "ACCOUNT_PAYABLE_INVALID_REFERENCE" });
  });

  it("stays on a bill whose responsible left, and the bill stays editable", async () => {
    const created = await create().execute(bill(ACTIVE), ADMIN);

    revoke(ACTIVE);

    // The web sends the whole form back, the kept responsible included.
    await update().execute(
      { registrationUserId: ACTIVE, amount: 700 },
      created.id,
      CARRIER,
      ADMIN,
    );

    expect(bills.accountPayables[0]).toMatchObject({
      registrationUserId: ACTIVE,
      amount: "700",
    });
  });
});

describe("a Kanban card's assignee", () => {
  const card = (columnId: string, assignedUserId?: string) => ({
    title: "Revisar pneus",
    description: "Descrição",
    priority: "high",
    dueDate: "2026-10-01T12:00:00.000Z",
    columnId,
    ...(assignedUserId && { assignedUserId }),
  });

  const column = () =>
    new CreateKanbanColumnUseCase(users, businesses, board).execute(
      { title: "Col", color: "#000", businessId: CARRIER },
      ADMIN,
    );

  const createCard = () =>
    new CreateKanbanCardUseCase(users, board, outbox, businesses);
  const updateCard = () =>
    new UpdateKanbanCardUseCase(users, board, outbox, businesses);

  it("is never a revoked or removed login", async () => {
    const { id } = await column();

    for (const assignee of [REVOKED, REMOVED]) {
      await expect(
        createCard().execute(card(id, assignee), ADMIN),
      ).rejects.toMatchObject(NOT_ASSIGNABLE);
    }

    const created = await createCard().execute(card(id), ADMIN);

    await expect(
      updateCard().execute({ assignedUserId: REMOVED }, created.id, ADMIN),
    ).rejects.toMatchObject(NOT_ASSIGNABLE);
  });

  it("stays on a card whose assignee left, and the card stays editable", async () => {
    const { id } = await column();
    const created = await createCard().execute(card(id, ACTIVE), ADMIN);

    revoke(ACTIVE);

    const updated = await updateCard().execute(
      { title: "Revisar pneus e freios", assignedUserId: ACTIVE },
      created.id,
      ADMIN,
    );

    expect(updated).toMatchObject({
      title: "Revisar pneus e freios",
      assignedUserId: ACTIVE,
    });
  });
});

describe("a service order's responsible", () => {
  const kanbanService = { createCardFromServiceOrder: vi.fn() } as never;

  const create = () =>
    new CreateServiceOrderUseCase(
      users,
      businesses,
      vehicles,
      branches,
      suppliers,
      orders,
      outbox,
      kanbanService,
    );

  const update = () =>
    new UpdateServiceOrderUseCase(
      users,
      businesses,
      vehicles,
      branches,
      suppliers,
      orders,
      outbox,
    );

  const order = (responsibleUserId: string) =>
    ({
      businessId: CARRIER,
      vehicleId: VEHICLE,
      branchId: BRANCH,
      responsibleUserId,
      date: "2026-10-01",
      status: "OPEN",
    }) as never;

  const stored = (responsibleUserId: string) => {
    const id = "018f2600-0000-7000-8000-0000000000f1";

    orders.serviceOrders.push({
      id,
      businessId: CARRIER,
      vehicleId: VEHICLE,
      branchId: BRANCH,
      responsibleUserId,
    } as never);

    return id;
  };

  it("is never a revoked or removed login", async () => {
    for (const responsible of [REVOKED, REMOVED]) {
      await expect(
        create().execute(order(responsible), ADMIN),
      ).rejects.toMatchObject(NOT_ASSIGNABLE);
    }

    const id = stored(ACTIVE);

    await expect(
      update().execute(
        { responsibleUserId: REVOKED } as never,
        id,
        CARRIER,
        ADMIN,
      ),
    ).rejects.toMatchObject(NOT_ASSIGNABLE);
  });

  it("is not refused when the edit keeps the one the order already names", async () => {
    const id = stored(REVOKED);

    expect(
      await outcome(() =>
        update().execute(
          { responsibleUserId: REVOKED } as never,
          id,
          CARRIER,
          ADMIN,
        ),
      ),
    ).not.toBe("USER_NOT_ASSIGNABLE");
  });
});

describe("a vehicle's responsible", () => {
  it("is never a revoked or removed login, and a foreign one is still 'not found'", async () => {
    for (const responsible of [REVOKED, REMOVED]) {
      await expect(
        assertResponsibleUser(users, responsible, CARRIER),
      ).rejects.toMatchObject(NOT_ASSIGNABLE);
    }

    await expect(
      assertResponsibleUser(users, FOREIGN_REVOKED, CARRIER),
    ).rejects.toMatchObject({ code: "RESPONSIBLE_USER_NOT_FOUND" });

    await expect(
      assertResponsibleUser(users, ACTIVE, CARRIER),
    ).resolves.toBeUndefined();
  });
});

/**
 * The class of bug, not the four cases: any use case that looks up the
 * person a body names as responsible or assignee must also run the
 * assignable check. A fifth assignment (a new module's "responsável") that
 * forgets it fails here instead of paging a login nobody can open.
 */
describe("every assignment a use case checks", () => {
  const MODULES = path.resolve(__dirname, "../../../src/modules");
  const NAMES_ASSIGNMENT =
    /findUserById\(\s*[\w.]*(?:responsibleUserId|assignedUserId|registrationUserId)\b/;

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);

      if (statSync(full).isDirectory()) return sourceFiles(full);

      return full.endsWith(".ts") ? [full] : [];
    });
  }

  it("also refuses a login that can no longer sign in", () => {
    const checking = sourceFiles(MODULES).filter((file) =>
      NAMES_ASSIGNMENT.test(readFileSync(file, "utf8")),
    );
    const offenders = checking
      .filter(
        (file) => !readFileSync(file, "utf8").includes("assertAssignableUser("),
      )
      .map((file) => path.relative(MODULES, file).replace(/\\/g, "/"));

    // The guard must see the known call sites, or it guards nothing.
    expect(checking.length).toBeGreaterThanOrEqual(6);
    expect(offenders).toEqual([]);
  });
});
