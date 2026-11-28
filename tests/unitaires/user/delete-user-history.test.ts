import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@prisma/client";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { DeleteUserUseCase } from "@/modules/user/usecases/delete-user/delete-user-usecase";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";

/**
 * Deleting a login is for one made by mistake (batch of 14/11/2026, docs/
 * arquitetura.md "Excluir x inativar/revogar"):
 *
 * - a driver's login whose route still needs it is refused, as the
 *   revocation is (K10): starting a route writes no row naming the login, so
 *   the delete went through and the route waited for nobody;
 * - every record the person authored is counted and named, in place of the
 *   generic "por exemplo" the RESTRICT key used to return;
 * - what belongs to the Driver (fuelings, checklists, routes) does not hold
 *   the login;
 * - a row committed between the count and the delete meets the foreign key
 *   (P2003) and gets the answer the count would have given.
 */
vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: () => {},
  sendCatalogChangedEvent: () => {},
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: (run: (client: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000e201";
const ADMIN = "018f0000-0000-7000-8000-00000000e2a1";
const LOGIN = "018f0000-0000-7000-8000-00000000e2b1";
const DRIVER = "018f0000-0000-7000-8000-00000000e2d1";

const notifications = {
  createActivityIfEnabled: async () => undefined,
} as unknown as NotificationService;

let users: InMemoryUserRepository;
let drivers: InMemoryDriverRepository;

beforeEach(() => {
  users = new InMemoryUserRepository();
  drivers = new InMemoryDriverRepository();

  users.user.push(
    {
      id: ADMIN,
      name: "Gestora",
      email: "gestora@alfa.com.br",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: LOGIN,
      name: "João Motorista",
      email: null,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: DRIVER,
    } as User,
  );
  drivers.drivers.push({
    id: DRIVER,
    name: "João Motorista",
    businessId: BUSINESS,
    status: "ACTIVE",
  } as Driver);
});

const remove = () => new DeleteUserUseCase(users, drivers, notifications);

const loginKept = () => users.user.some((user) => user.id === LOGIN);

describe("deleting a driver's login", () => {
  it.each(["PLANNED", "RELEASED", "IN_PROGRESS"])(
    "is refused while the driver has a %s route, and the login stays",
    async (status) => {
      drivers.routes.push({ driverId: DRIVER, status });

      await expect(
        remove().execute({ userId: LOGIN, id: ADMIN }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "DRIVER_HAS_OPEN_ROUTES",
        message: expect.stringContaining("Não é possível excluir este usuário"),
      });

      expect(loginKept()).toBe(true);
    },
  );

  it("goes through when the driver's routes are closed and the login left nothing", async () => {
    drivers.routes.push(
      { driverId: DRIVER, status: "COMPLETED" },
      { driverId: DRIVER, status: "CANCELLED" },
    );

    await remove().execute({ userId: LOGIN, id: ADMIN });

    expect(loginKept()).toBe(false);
  });

  it("names the counted records and points to revoking", async () => {
    users.authoredRows.push(
      { userId: LOGIN, kind: "deliveryEvents" },
      { userId: LOGIN, kind: "deliveryEvents" },
      { userId: LOGIN, kind: "chatMessages" },
    );

    await expect(
      remove().execute({ userId: LOGIN, id: ADMIN }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "USER_HAS_RECORDS",
      message: expect.stringContaining(
        "2 evento(s) de entrega e 1 mensagem(ns) no chat",
      ),
    });

    expect(loginKept()).toBe(true);
  });

  it("refuses a login responsible for service orders with their own code", async () => {
    users.authoredRows.push({ userId: LOGIN, kind: "serviceOrders" });

    await expect(
      remove().execute({ userId: LOGIN, id: ADMIN }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "USER_HAS_SERVICE_ORDERS",
    });
  });
});

describe("a record committed between the count and the delete", () => {
  it("answers the recount, not a generic sentence", async () => {
    // The count saw nothing; an occurrence lands before the DELETE, which
    // the RESTRICT key refuses.
    const realCount = users.countUserHistory.bind(users);
    let counts = 0;

    users.countUserHistory = async (userId) => {
      counts += 1;

      return realCount(userId);
    };

    const realDelete = users.deleteUser.bind(users);

    users.deleteUser = async (userId) => {
      users.authoredRows.push({ userId: LOGIN, kind: "occurrences" });

      return realDelete(userId);
    };

    await expect(
      remove().execute({ userId: LOGIN, id: ADMIN }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "USER_HAS_RECORDS",
      message: expect.stringContaining("1 ocorrência(s)"),
    });

    expect(counts).toBe(2);
    expect(loginKept()).toBe(true);
  });

  it("keeps the generic sentence for a key the count does not know", async () => {
    users.deleteUser = async () => {
      throw new Prisma.PrismaClientKnownRequestError("fk", {
        code: "P2003",
        clientVersion: "test",
      });
    };

    await expect(
      remove().execute({ userId: LOGIN, id: ADMIN }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "USER_HAS_RECORDS",
      message: expect.stringContaining("por exemplo"),
    });
  });
});
