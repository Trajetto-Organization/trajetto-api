import { describe, expect, it, vi } from "vitest";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";
import { DeleteUserUseCase } from "@/modules/user/usecases/delete-user/delete-user-usecase";

import type { NotificationService } from "@/shared/services/notification-service";
import type { User } from "@/modules/user/dtos/user-dto";

/**
 * User.email is nullable from migration 20261102120100 (plan of 02/11/2026,
 * D2): a driver's login may have no e-mail. Every reader has to treat the
 * absence — the audit line of a deletion used to print "| null deletado"
 * for such a driver.
 */
vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: () => {},
  sendSecurityEventToBusiness: () => {},
  sendCatalogChangedEvent: () => {},
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: (run: (client: unknown) => Promise<unknown>) => run({}),
  },
}));

const BUSINESS = "018f0000-0000-7000-8000-00000000d201";
const ADMIN = "018f0000-0000-7000-8000-00000000d2a1";
const DRIVER_LOGIN = "018f0000-0000-7000-8000-00000000d2b1";

function deleteWith(descriptions: string[]) {
  const users = new InMemoryUserRepository();

  users.user.push(
    {
      id: ADMIN,
      name: "Gestora",
      email: "gestora@alfa.com.br",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User,
    {
      id: DRIVER_LOGIN,
      name: "João Motorista",
      email: null,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
    } as User,
  );

  const notifications = {
    createActivityIfEnabled: async (activity: { description: string }) => {
      descriptions.push(activity.description);
    },
  } as unknown as NotificationService;

  return new DeleteUserUseCase(
    users,
    new InMemoryServiceOrderRepository(),
    new InMemoryAccountPayableRepository(),
    notifications,
  );
}

describe("deleting a driver's login without an e-mail", () => {
  it("writes an audit line that names the user without a 'null' address", async () => {
    const descriptions: string[] = [];

    await deleteWith(descriptions).execute({
      userId: DRIVER_LOGIN,
      id: ADMIN,
    });

    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toContain("João Motorista");
    expect(descriptions[0]).not.toContain("null");
  });
});
