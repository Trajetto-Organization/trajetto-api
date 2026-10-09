import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { NotificationService } from "@/shared/services/notification-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemorySupplierRepository } from "@/modules/supplier/repositories/in-memory/in-memory-supplier-repository";

import { CreateSupplierUseCase } from "@/modules/supplier/usecases/create-supplier/create-supplier-usecase";
import { UpdateSupplierUseCase } from "@/modules/supplier/usecases/update-supplier/update-supplier-usecase";
import { DeleteSupplierUseCase } from "@/modules/supplier/usecases/delete-supplier/delete-supplier-usecase";
import { ListSupplierUseCase } from "@/modules/supplier/usecases/list-supplier/list-supplier-usecase";

/**
 * Supplier rules on the in-memory twins (the HTTP and SQL side is in
 * tests/E2E/supplier-http.test.ts). The websocket is the one thing replaced:
 * what is proven is that the use case announces the change.
 */
const realtime = vi.hoisted(() => ({
  catalogChanged: [] as Array<{ businessId: string; entity: string }>,
}));

vi.mock("@/websocket", () => ({
  sendCatalogChangedEvent: (businessId: string, entity: string) => {
    realtime.catalogChanged.push({ businessId, entity });
  },
}));

const CARRIER = "018f1000-0000-7000-8000-00000000000a";
const OTHER = "018f1000-0000-7000-8000-00000000000b";

const ADMIN = "018f1000-0000-7000-8000-0000000000a1";
const OTHER_ADMIN = "018f1000-0000-7000-8000-0000000000a2";
const MASTER = "018f1000-0000-7000-8000-0000000000a3";

const notifications = {
  createActivityIfEnabled: vi.fn(),
} as unknown as NotificationService;

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let suppliers: InMemorySupplierRepository;

const supplierOf = (overrides: Record<string, unknown> = {}) => ({
  name: "Oficina Central Diesel",
  cnpj: "11222333000181",
  email: "compras@oficina.com.br",
  businessId: CARRIER,
  ...overrides,
});

beforeEach(() => {
  realtime.catalogChanged.length = 0;

  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  suppliers = new InMemorySupplierRepository();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: OTHER_ADMIN, role: "BUSINESS_ADMIN", businessId: OTHER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
  businesses.business.push(
    { id: CARRIER } as Business,
    { id: OTHER } as Business,
  );
});

const create = () =>
  new CreateSupplierUseCase(users, businesses, suppliers, notifications);
const update = () =>
  new UpdateSupplierUseCase(users, businesses, suppliers, notifications);
const remove = () =>
  new DeleteSupplierUseCase(users, businesses, suppliers, notifications);

describe("supplier uniqueness is per company (FLEET-SUP-2, decision 8.1)", () => {
  it("lets two carriers register the same workshop, e-mail included", async () => {
    await create().execute(supplierOf(), ADMIN);

    // The old lookup ignored the company: the second carrier got "e-mail not
    // available" — and learned the address existed in another tenant.
    const second = await create().execute(
      supplierOf({ businessId: OTHER }),
      OTHER_ADMIN,
    );

    expect(second.businessId).toBe(OTHER);
    expect(suppliers.suppliers).toHaveLength(2);
  });

  it("refuses the same e-mail in the same company, ignoring case, with a 409", async () => {
    await create().execute(supplierOf(), ADMIN);

    await expect(
      create().execute(
        supplierOf({
          name: "Outra Oficina Ltda",
          cnpj: "99888777000166",
          email: "COMPRAS@oficina.com.br",
        }),
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "SUPPLIER_EMAIL_TAKEN" });
  });

  it("refuses the same name in the same company, ignoring case", async () => {
    await create().execute(supplierOf(), ADMIN);

    await expect(
      create().execute(
        supplierOf({
          name: "OFICINA CENTRAL DIESEL",
          cnpj: "99888777000166",
          email: null,
        }),
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "SUPPLIER_NAME_TAKEN" });
  });

  it("lets an edit keep its own e-mail", async () => {
    const created = await create().execute(supplierOf(), ADMIN);

    await expect(
      update().execute(
        { ...supplierOf(), telephone: "11999998888" },
        created.id,
        CARRIER,
        ADMIN,
      ),
    ).resolves.toMatchObject({ telephone: "11999998888" });
  });
});

describe("a supplier never changes company", () => {
  it("refuses the MASTER naming another company, and moves nothing", async () => {
    const created = await create().execute(supplierOf(), ADMIN);

    // The old update skipped the check for the MASTER and wrote businessId:
    // the supplier left for OTHER while its parts and orders stayed here.
    await expect(
      update().execute({ name: "Oficina Movida Ltda" }, created.id, OTHER, MASTER),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "SUPPLIER_TENANT_MISMATCH",
    });

    expect(suppliers.suppliers[0]).toMatchObject({
      businessId: CARRIER,
      name: "Oficina Central Diesel",
    });
  });
});

describe("a supplier with history is not deleted (FLEET-SUP-1)", () => {
  it("refuses with the counts and keeps the supplier", async () => {
    const created = await create().execute(supplierOf(), ADMIN);

    suppliers.references.set(created.id, {
      serviceOrders: 2,
      parts: 1,
      accountsPayable: 3,
    });

    await expect(
      remove().execute(created.id, CARRIER, ADMIN),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SUPPLIER_IN_USE",
      message:
        "Não é possível excluir este fornecedor: ele está vinculado a 2 ordens de serviço, 1 peça e 3 contas a pagar. Excluí-lo apagaria o fornecedor desse histórico.",
    });

    expect(suppliers.suppliers).toHaveLength(1);
  });

  it("deletes one nothing references", async () => {
    const created = await create().execute(supplierOf(), ADMIN);

    await remove().execute(created.id, CARRIER, ADMIN);

    expect(suppliers.suppliers).toHaveLength(0);
  });
});

describe("other screens hear about the change (decision 2.3)", () => {
  it("emits catalogChanged supplier after create, update and delete", async () => {
    const created = await create().execute(supplierOf(), ADMIN);
    await update().execute({ ...supplierOf(), city: "Campinas" }, created.id, CARRIER, ADMIN);
    await remove().execute(created.id, CARRIER, ADMIN);

    expect(realtime.catalogChanged).toEqual([
      { businessId: CARRIER, entity: "supplier" },
      { businessId: CARRIER, entity: "supplier" },
      { businessId: CARRIER, entity: "supplier" },
    ]);
  });

  it("emits nothing when the write is refused", async () => {
    const created = await create().execute(supplierOf(), ADMIN);
    realtime.catalogChanged.length = 0;

    suppliers.references.set(created.id, { serviceOrders: 1, parts: 0, accountsPayable: 0 });
    await expect(remove().execute(created.id, CARRIER, ADMIN)).rejects.toThrow();

    expect(realtime.catalogChanged).toEqual([]);
  });
});

describe("the list is one company's", () => {
  it("asks the MASTER to pick a company instead of mixing tenants", async () => {
    await expect(
      new ListSupplierUseCase(users, suppliers).execute({
        userId: MASTER,
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "BUSINESS_NOT_IDENTIFIED" });
  });

  it("refuses a manager naming another company", async () => {
    await expect(
      new ListSupplierUseCase(users, suppliers).execute({
        userId: ADMIN,
        businessId: OTHER,
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
