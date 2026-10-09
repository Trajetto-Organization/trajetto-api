import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The MASTER accounts (create, edit, remove, list) and the company user
 * reads (list, picker) — TEST-UC-1.
 *
 * Replaced: the mail provider, the websocket, the transaction runner and the
 * outbox (whose publish is what is asserted: the notices commit with the row).
 */
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ email: string; templateName: string }>,
}));

const realtime = vi.hoisted(() => ({
  securityEvents: [] as Array<{ userId: string; reason: string }>,
}));

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async (props: { email: string; templateName: string }) => {
    mail.sent.push({ email: props.email, templateName: props.templateName });
  },
}));

vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: (userId: string, payload: { reason: string }) => {
    realtime.securityEvents.push({ userId, reason: payload.reason });
  },
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

import { Prisma } from "@prisma/client";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { ServiceOrder } from "@/modules/service-order/dtos/service-order-dto";
import type { AccountPayable } from "@/modules/account-payable/dtos/account-payable-dto";
import type { NotificationService } from "@/shared/services/notification-service";
import type { OutboxService } from "@/shared/notifications/outbox-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";
import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";

import { CreateMasterUserUseCase } from "@/modules/user/usecases/create-master-user/create-master-user-usecase";
import { UpdateMasterUserUseCase } from "@/modules/user/usecases/update-master-user/update-master-user-usecase";
import { DeleteMasterUserUseCase } from "@/modules/user/usecases/delete-master-user/delete-master-user-usecase";
import { ListMasterUsersUseCase } from "@/modules/user/usecases/list-master-users/list-master-users-usecase";
import { ListUsersUseCase } from "@/modules/user/usecases/list-users/list-users-usecase";
import { SearchUserCursorUseCase } from "@/modules/user/usecases/search-user-cursor/search-user-cursor-usecase";

const CARRIER = "018f3400-0000-7000-8000-00000000000a";
const OTHER = "018f3400-0000-7000-8000-00000000000b";

const MASTER = "018f3400-0000-7000-8000-0000000000a1";
const MASTER_TWO = "018f3400-0000-7000-8000-0000000000a2";
const ADMIN = "018f3400-0000-7000-8000-0000000000a3";
const CLERK = "018f3400-0000-7000-8000-0000000000a4";
const OTHER_CLERK = "018f3400-0000-7000-8000-0000000000a5";
const UNKNOWN = "018f3400-0000-7000-8000-0000000000ff";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let businesses: InMemoryBusinessRepository;
let orders: InMemoryServiceOrderRepository;
let payables: InMemoryAccountPayableRepository;
let published: Array<{ topic: string; aggregateId: string }>;
let outbox: OutboxService;

const notifications = {
  createActivityIfEnabled: vi.fn(async () => undefined),
} as unknown as NotificationService;

const person = (overrides: Partial<User>) =>
  ({
    password: "x",
    session_version: 0,
    two_factor_enabled: false,
    access_revoked: false,
    profileAccessId: null,
    driverId: null,
    created_at: new Date("2026-09-01T12:00:00Z"),
    ...overrides,
  }) as User;

/** Lets the fire-and-forget e-mails settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  mail.sent.length = 0;
  realtime.securityEvents.length = 0;
  vi.mocked(notifications.createActivityIfEnabled).mockClear();

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  businesses = new InMemoryBusinessRepository();
  orders = new InMemoryServiceOrderRepository();
  payables = new InMemoryAccountPayableRepository();

  published = [];
  outbox = {
    publish: vi.fn(async (_tx: unknown, event: { topic: string; aggregateId: string }) => {
      published.push({ topic: event.topic, aggregateId: event.aggregateId });
    }),
  } as unknown as OutboxService;

  users.user.push(
    person({ id: MASTER, name: "Master Um", email: "um@trajetto.com.br", role: "MASTER", businessId: null }),
    person({ id: MASTER_TWO, name: "Master Dois", email: "dois@trajetto.com.br", role: "MASTER", businessId: null }),
    person({ id: ADMIN, name: "Admin", email: "admin@a.com.br", role: "BUSINESS_ADMIN", businessId: CARRIER }),
    person({ id: CLERK, name: "Carla Dias", email: "carla@a.com.br", role: "BUSINESS_USER", businessId: CARRIER, created_at: new Date("2026-09-02T12:00:00Z") } as Partial<User>),
    person({ id: OTHER_CLERK, name: "Bruno", email: "bruno@b.com.br", role: "BUSINESS_USER", businessId: OTHER }),
  );
  businesses.business.push({ id: CARRIER } as Business, { id: OTHER } as Business);
});

describe("creating a MASTER", () => {
  const create = () => new CreateMasterUserUseCase(users, tokens, outbox);

  it("creates the account, publishes both notices with it and mails a set-password link", async () => {
    const created = await create().execute(
      { name: "Master Três", email: "tres@trajetto.com.br" },
      MASTER,
    );
    await settle();

    expect(created).toMatchObject({ role: "MASTER", businessId: null });
    expect(published.map((event) => event.topic)).toEqual([
      "master-user.created",
      "master-user.welcomed",
    ]);
    expect(mail.sent.map((entry) => entry.templateName).sort()).toEqual([
      "email-verification.hbs",
      "user-created-successfully.hbs",
    ]);
    expect(tokens.forgotPasswordVerificationTokens).toHaveLength(1);
  });

  it("refuses anyone but a MASTER (403) and publishes nothing", async () => {
    await expect(
      create().execute({ name: "X", email: "x@trajetto.com.br" }, ADMIN),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
    expect(published).toEqual([]);
  });

  it("refuses an e-mail already in use, whatever its case (409)", async () => {
    await expect(
      create().execute({ name: "X", email: "CARLA@a.com.br" }, MASTER),
    ).rejects.toMatchObject({ statusCode: 409, code: "USER_ALREADY_EXISTS" });
  });

  it("refuses an unknown caller (404)", async () => {
    await expect(
      create().execute({ name: "X", email: "x@trajetto.com.br" }, UNKNOWN),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("editing a MASTER", () => {
  const update = () => new UpdateMasterUserUseCase(users, outbox, tokens);

  it("renames, publishes the two notices and mails the account", async () => {
    const updated = await update().execute({
      masterUserId: MASTER_TWO,
      data: { name: "Master Dois Silva" },
      performedById: MASTER,
    });
    await settle();

    expect(updated.name).toBe("Master Dois Silva");
    expect(published.map((event) => event.topic)).toEqual([
      "master-user.updated",
      "master-user.account-updated",
    ]);
    expect(mail.sent).toEqual([
      { email: "dois@trajetto.com.br", templateName: "master-user-updated.hbs" },
    ]);
    // A rename keeps the session.
    expect(realtime.securityEvents).toEqual([]);
  });

  it("asks open screens to re-read the session after an e-mail change", async () => {
    await update().execute({
      masterUserId: MASTER_TWO,
      data: { email: "novo@trajetto.com.br" },
      performedById: MASTER,
    });

    expect(realtime.securityEvents).toEqual([
      { userId: MASTER_TWO, reason: "permissions_changed" },
    ]);
  });

  it("does nothing for an unchanged form", async () => {
    await update().execute({
      masterUserId: MASTER_TWO,
      data: { name: "Master Dois", email: "dois@trajetto.com.br" },
      performedById: MASTER,
    });

    expect(published).toEqual([]);
  });

  it("refuses editing yourself, a company user and a non-MASTER caller", async () => {
    await expect(
      update().execute({ masterUserId: MASTER, data: { name: "Eu" }, performedById: MASTER }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });

    await expect(
      update().execute({ masterUserId: CLERK, data: { name: "X" }, performedById: MASTER }),
    ).rejects.toMatchObject({ statusCode: 404, code: "MASTER_USER_NOT_FOUND" });

    await expect(
      update().execute({ masterUserId: MASTER_TWO, data: { name: "X" }, performedById: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });

    expect(users.user.find((u) => u.id === CLERK)?.name).toBe("Carla Dias");
    expect(published).toEqual([]);
  });

  it("refuses an e-mail taken by another account (409)", async () => {
    await expect(
      update().execute({
        masterUserId: MASTER_TWO,
        data: { email: "carla@a.com.br" },
        performedById: MASTER,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "USER_ALREADY_EXISTS" });
  });

  it("fails whole (503) when the reset link cannot be stored, and changes nothing", async () => {
    tokens.createForgotPasswordVerificationToken = async () => {
      throw new Error("connection reset");
    };

    await expect(
      update().execute({
        masterUserId: MASTER_TWO,
        data: { name: "Outro", sendPasswordSetupLink: true },
        performedById: MASTER,
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "PASSWORD_LINK_UNAVAILABLE" });

    expect(users.user.find((u) => u.id === MASTER_TWO)?.name).toBe("Master Dois");
    expect(published).toEqual([]);
  });
});

describe("removing a MASTER", () => {
  const remove = () => new DeleteMasterUserUseCase(users, orders, payables, notifications);

  it("removes another MASTER, logs it and closes their sockets", async () => {
    const deleted = await remove().execute({ masterUserId: MASTER_TWO, performedById: MASTER });

    expect(deleted.id).toBe(MASTER_TWO);
    expect(users.user.some((u) => u.id === MASTER_TWO)).toBe(false);
    expect(notifications.createActivityIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", visibilityLevel: "SYSTEM" }),
      expect.anything(),
    );
    expect(realtime.securityEvents).toEqual([{ userId: MASTER_TWO, reason: "access_denied" }]);
  });

  it("refuses with a 409 when the locked delete says the target is the last MASTER", async () => {
    // The count happens inside the repository's transaction (two concurrent
    // removals cannot both pass); its null answer is what the use case turns
    // into the refusal, without logging or closing any socket.
    users.deleteMasterUserKeepingOne = async () => null;

    await expect(
      remove().execute({ masterUserId: MASTER_TWO, performedById: MASTER }),
    ).rejects.toMatchObject({ statusCode: 409, code: "LAST_MASTER_USER" });

    expect(notifications.createActivityIfEnabled).not.toHaveBeenCalled();
    expect(realtime.securityEvents).toEqual([]);
  });

  it("refuses a MASTER with service orders or payables in their name (409)", async () => {
    orders.serviceOrders.push({ id: "so-1", responsibleUserId: MASTER_TWO } as ServiceOrder);

    await expect(
      remove().execute({ masterUserId: MASTER_TWO, performedById: MASTER }),
    ).rejects.toMatchObject({ statusCode: 409, code: "USER_HAS_SERVICE_ORDERS" });

    orders.serviceOrders.length = 0;
    payables.accountPayables.push({ id: "ap-1", registrationUserId: MASTER_TWO } as AccountPayable);

    await expect(
      remove().execute({ masterUserId: MASTER_TWO, performedById: MASTER }),
    ).rejects.toMatchObject({ statusCode: 409, code: "USER_HAS_ACCOUNT_PAYABLES" });

    expect(users.user.some((u) => u.id === MASTER_TWO)).toBe(true);
  });

  it("answers a RESTRICT foreign key as a 409, not a 500", async () => {
    users.deleteMasterUserKeepingOne = async () => {
      throw new Prisma.PrismaClientKnownRequestError("fk", {
        code: "P2003",
        clientVersion: "test",
      });
    };

    await expect(
      remove().execute({ masterUserId: MASTER_TWO, performedById: MASTER }),
    ).rejects.toMatchObject({ statusCode: 409, code: "USER_HAS_RECORDS" });
  });

  it("refuses yourself, a company user and a non-MASTER caller", async () => {
    await expect(
      remove().execute({ masterUserId: MASTER, performedById: MASTER }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });

    await expect(
      remove().execute({ masterUserId: CLERK, performedById: MASTER }),
    ).rejects.toMatchObject({ statusCode: 404, code: "MASTER_USER_NOT_FOUND" });

    await expect(
      remove().execute({ masterUserId: MASTER_TWO, performedById: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });

    expect(users.user).toHaveLength(5);
  });
});

describe("listing MASTER accounts", () => {
  it("lists the other MASTERs, never the caller", async () => {
    const result = await new ListMasterUsersUseCase(users).execute({
      userId: MASTER,
      page: 1,
      pageSize: 10,
    });

    expect(result.data.map((row) => row.id)).toEqual([MASTER_TWO]);
    expect(result.total).toBe(1);
  });

  it("refuses an unknown caller (404)", async () => {
    await expect(
      new ListMasterUsersUseCase(users).execute({ userId: UNKNOWN, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a company admin itself, not only at the route (403 PERMISSION_DENIED)", async () => {
    // Red before: the use case trusted verifyUserRole(['MASTER']) above it
    // and listed every MASTER account to whoever reached it.
    await expect(
      new ListMasterUsersUseCase(users).execute({ userId: ADMIN, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });
});

describe("listing a company's users", () => {
  const list = () => new ListUsersUseCase(users, businesses);

  it("pins a company user to their own company and hides the caller", async () => {
    const result = await list().execute({ userId: ADMIN, page: 1, pageSize: 10 });

    expect(result.data.map((row) => row.id)).toEqual([CLERK]);
  });

  it("refuses a company user naming another company (403)", async () => {
    await expect(
      list().execute({ userId: ADMIN, businessId: OTHER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
  });

  it("asks the MASTER for a company (400), refuses an unknown one (404), serves the picked one", async () => {
    await expect(
      list().execute({ userId: MASTER, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 400, code: "BUSINESS_NOT_IDENTIFIED" });

    await expect(
      list().execute({ userId: MASTER, businessId: UNKNOWN, page: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });

    const result = await list().execute({
      userId: MASTER,
      businessId: OTHER,
      page: 1,
      pageSize: 10,
    });

    expect(result.data.map((row) => row.id)).toEqual([OTHER_CLERK]);
  });
});

describe("the user picker (cursor)", () => {
  const search = () => new SearchUserCursorUseCase(users, businesses);

  it("finds the company's users by name or e-mail", async () => {
    const result = await search().execute({ userId: ADMIN, businessId: CARRIER, search: "carla" });

    expect(result.data.map((row) => row.id)).toEqual([CLERK]);
  });

  it("refuses another company (403) and an unknown company (404)", async () => {
    await expect(
      search().execute({ userId: ADMIN, businessId: OTHER }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    await expect(
      search().execute({ userId: MASTER, businessId: UNKNOWN }),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });
});
