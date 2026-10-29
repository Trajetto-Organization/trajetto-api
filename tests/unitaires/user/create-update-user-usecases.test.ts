import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Creating and editing company users (TEST-UC-1): who may create or edit
 * which role, the tenant of the caller, of the person and of the links
 * (profile, driver), the e-mail uniqueness and what an edit really changes.
 *
 * Replaced: the mail provider, the websocket and the transaction runner (the
 * twin has no transaction; the writes run in order on it).
 */
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ email: string; templateName: string; url?: unknown }>,
}));

const realtime = vi.hoisted(() => ({
  securityEvents: [] as Array<{ userId: string; reason: string }>,
  catalogChanged: [] as Array<{ businessId: string; entity: string }>,
}));

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async (props: {
    email: string;
    templateName: string;
    additionalVariablesProperties?: Record<string, unknown>;
  }) => {
    mail.sent.push({
      email: props.email,
      templateName: props.templateName,
      url: props.additionalVariablesProperties?.url,
    });
  },
}));

vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: (userId: string, payload: { reason: string }) => {
    realtime.securityEvents.push({ userId, reason: payload.reason });
  },
  refreshDeliveryRooms: async () => undefined,
  sendCatalogChangedEvent: (businessId: string, entity: string) => {
    realtime.catalogChanged.push({ businessId, entity });
  },
}));

vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { NotificationService } from "@/shared/services/notification-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { CreateUserUseCase } from "@/modules/user/usecases/create-user/create-user-usecase";
import { UpdateUserUseCase } from "@/modules/user/usecases/update-user/update-user-usecase";

const CARRIER = "018f3300-0000-7000-8000-00000000000a";
const OTHER = "018f3300-0000-7000-8000-00000000000b";

const ADMIN = "018f3300-0000-7000-8000-0000000000a1";
const OTHER_ADMIN = "018f3300-0000-7000-8000-0000000000a2";
const MASTER = "018f3300-0000-7000-8000-0000000000a3";
const CLERK = "018f3300-0000-7000-8000-0000000000a4";
const SECOND_ADMIN = "018f3300-0000-7000-8000-0000000000a5";
const MASTER_TWO = "018f3300-0000-7000-8000-0000000000a6";

const PROFILE = "018f3300-0000-7000-8000-0000000000b1";
const FOREIGN_PROFILE = "018f3300-0000-7000-8000-0000000000b2";

const DRIVER = "018f3300-0000-7000-8000-0000000000d1";
const FOREIGN_DRIVER = "018f3300-0000-7000-8000-0000000000d2";

const notifications = {
  createActivityIfEnabled: vi.fn(async () => undefined),
} as unknown as NotificationService;

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let businesses: InMemoryBusinessRepository;
let profiles: InMemoryProfileAccessRepository;
let drivers: InMemoryDriverRepository;

const person = (overrides: Partial<User>) =>
  ({
    name: "Pessoa",
    password: "x",
    session_version: 0,
    two_factor_enabled: false,
    access_revoked: false,
    profileAccessId: null,
    driverId: null,
    ...overrides,
  }) as User;

beforeEach(() => {
  mail.sent.length = 0;
  realtime.securityEvents.length = 0;
  realtime.catalogChanged.length = 0;
  vi.mocked(notifications.createActivityIfEnabled).mockClear();

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  businesses = new InMemoryBusinessRepository();
  profiles = new InMemoryProfileAccessRepository();
  drivers = new InMemoryDriverRepository();

  users.user.push(
    person({
      id: ADMIN,
      email: "admin@a.com.br",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    }),
    person({
      id: OTHER_ADMIN,
      email: "admin@b.com.br",
      role: "BUSINESS_ADMIN",
      businessId: OTHER,
    }),
    person({
      id: MASTER,
      email: "master@t.com.br",
      role: "MASTER",
      businessId: null,
    }),
    person({
      id: MASTER_TWO,
      email: "master2@t.com.br",
      role: "MASTER",
      businessId: null,
    }),
    person({
      id: CLERK,
      name: "Carlos Lima",
      email: "carlos@a.com.br",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: PROFILE,
    }),
    person({
      id: SECOND_ADMIN,
      email: "admin2@a.com.br",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    }),
  );
  businesses.business.push(
    { id: CARRIER } as Business,
    { id: OTHER } as Business,
  );

  profiles.profileAccess.push(
    { id: PROFILE, name: "Operação", businessId: CARRIER } as never,
    { id: FOREIGN_PROFILE, name: "Operação", businessId: OTHER } as never,
  );

  drivers.drivers.push(
    {
      id: DRIVER,
      name: "João",
      businessId: CARRIER,
      status: "ACTIVE",
    } as Driver,
    {
      id: FOREIGN_DRIVER,
      name: "Pedro",
      businessId: OTHER,
      status: "ACTIVE",
    } as Driver,
  );
});

const create = () =>
  new CreateUserUseCase(
    users,
    businesses,
    profiles,
    tokens,
    notifications,
    drivers,
  );
const update = () =>
  new UpdateUserUseCase(users, profiles, notifications, drivers, tokens);

const newUser = (overrides: Record<string, unknown> = {}) => ({
  name: "Maria Prado",
  email: "maria@a.com.br",
  role: "BUSINESS_USER" as const,
  businessId: CARRIER,
  profileAccessId: PROFILE,
  ...overrides,
});

/** Lets the fire-and-forget e-mails settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("creating a company user", () => {
  it("creates the account with an unusable password and mails a set-password link, never a password", async () => {
    const created = await create().execute(newUser() as never, ADMIN);
    await settle();

    expect(created).toMatchObject({
      email: "maria@a.com.br",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: PROFILE,
      driverId: null,
    });
    expect(created.password).toMatch(/^\$2[aby]\$10\$/);

    const welcome = mail.sent.find(
      (entry) => entry.templateName === "user-created-successfully.hbs",
    );
    expect(welcome?.url).toMatch(/\/forgot\/password\?token=/);
    expect(tokens.forgotPasswordVerificationTokens).toHaveLength(1);
  });

  it("drops the profile of an administrator", async () => {
    const created = await create().execute(
      newUser({ role: "BUSINESS_ADMIN", profileAccessId: PROFILE }) as never,
      ADMIN,
    );

    expect(created.profileAccessId).toBeNull();
  });

  it("links a driver of the company and tells the driver catalogue", async () => {
    const created = await create().execute(
      newUser({ profileAccessId: undefined, driverId: DRIVER }) as never,
      ADMIN,
    );

    expect(created.driverId).toBe(DRIVER);
    expect(realtime.catalogChanged).toEqual([
      { businessId: CARRIER, entity: "driver" },
    ]);
  });

  it("refuses a BUSINESS_USER creating an administrator (403 PERMISSION_DENIED)", async () => {
    await expect(
      create().execute(newUser({ role: "BUSINESS_ADMIN" }) as never, CLERK),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
    expect(
      users.user.find((u) => u.email === "maria@a.com.br"),
    ).toBeUndefined();
  });

  it("refuses an administrator creating a MASTER (403)", async () => {
    await expect(
      create().execute(newUser({ role: "MASTER" }) as never, ADMIN),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });

  it("refuses creating an account in another company (403 TENANT_ACCESS_DENIED)", async () => {
    await expect(
      create().execute(
        newUser({ businessId: OTHER, profileAccessId: undefined }) as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });
    expect(
      users.user.find((u) => u.email === "maria@a.com.br"),
    ).toBeUndefined();
  });

  it("refuses a profile or a driver of another company", async () => {
    await expect(
      create().execute(
        newUser({ profileAccessId: FOREIGN_PROFILE }) as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PROFILE_ACCESS_NOT_FOUND",
    });

    await expect(
      create().execute(
        newUser({
          profileAccessId: undefined,
          driverId: FOREIGN_DRIVER,
        }) as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "DRIVER_NOT_FOUND" });

    expect(
      users.user.find((u) => u.email === "maria@a.com.br"),
    ).toBeUndefined();
  });

  it("refuses both a profile and a driver, and a driver already linked", async () => {
    await expect(
      create().execute(newUser({ driverId: DRIVER }) as never, ADMIN),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "USER_PROFILE_AND_DRIVER",
    });

    await create().execute(
      newUser({
        email: "joao@a.com.br",
        profileAccessId: undefined,
        driverId: DRIVER,
      }) as never,
      ADMIN,
    );

    await expect(
      create().execute(
        newUser({ profileAccessId: undefined, driverId: DRIVER }) as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "DRIVER_ALREADY_LINKED" });
  });

  it("refuses an e-mail already in use, whatever its case (409)", async () => {
    await expect(
      create().execute(newUser({ email: "CARLOS@a.com.br" }) as never, ADMIN),
    ).rejects.toMatchObject({ statusCode: 409, code: "USER_ALREADY_EXISTS" });
  });

  it("refuses an unknown caller (404) and an unknown company for the MASTER (404)", async () => {
    await expect(
      create().execute(
        newUser() as never,
        "018f3300-0000-7000-8000-0000000000ff",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      create().execute(
        newUser({
          businessId: "018f3300-0000-7000-8000-0000000000fe",
        }) as never,
        MASTER,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "BUSINESS_NOT_FOUND" });
  });
});

describe("editing a company user", () => {
  it("renames without logging the person out", async () => {
    const updated = await update().execute(
      {
        userId: CLERK,
        userData: { name: "Carlos Lima Filho", email: "carlos@a.com.br" },
      } as never,
      ADMIN,
    );

    expect(updated.name).toBe("Carlos Lima Filho");
    expect(users.user.find((u) => u.id === CLERK)?.session_version).toBe(0);
    expect(realtime.securityEvents).toEqual([]);
  });

  it("changes nothing, and writes no audit entry, when the form is sent unchanged", async () => {
    await update().execute(
      {
        userId: CLERK,
        userData: {
          name: "Carlos Lima",
          email: "carlos@a.com.br",
          role: "BUSINESS_USER",
          businessId: CARRIER,
          profileAccessId: PROFILE,
        },
      } as never,
      ADMIN,
    );

    expect(notifications.createActivityIfEnabled).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
  });

  it("ends the sessions on a role change and says why", async () => {
    await update().execute(
      { userId: CLERK, userData: { role: "BUSINESS_ADMIN" } } as never,
      ADMIN,
    );

    const clerk = users.user.find((u) => u.id === CLERK);
    expect(clerk).toMatchObject({
      role: "BUSINESS_ADMIN",
      profileAccessId: null,
    });
    expect(clerk?.session_version).toBe(1);
    expect(realtime.securityEvents).toEqual([
      { userId: CLERK, reason: "role_changed" },
    ]);
  });

  it("refuses editing yourself", async () => {
    await expect(
      update().execute(
        { userId: ADMIN, userData: { name: "Eu" } } as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });

  it("refuses a BUSINESS_USER demoting an administrator (403)", async () => {
    await expect(
      update().execute(
        {
          userId: SECOND_ADMIN,
          userData: { role: "BUSINESS_USER", profileAccessId: PROFILE },
        } as never,
        CLERK,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });

    expect(users.user.find((u) => u.id === SECOND_ADMIN)?.role).toBe(
      "BUSINESS_ADMIN",
    );
  });

  it("answers another company's user like a missing one (404) and changes nothing", async () => {
    await expect(
      update().execute(
        { userId: CLERK, userData: { name: "Invasor" } } as never,
        OTHER_ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });

    expect(users.user.find((u) => u.id === CLERK)?.name).toBe("Carlos Lima");
  });

  // Decision 16.100: the route schema refuses a body businessId; a caller that
  // reaches the use case with one anyway still cannot move the person.
  it.each([
    ["BUSINESS_ADMIN", ADMIN],
    ["MASTER", MASTER],
  ])(
    "never moves a user to another company, even for a %s",
    async (_role, actor) => {
      await update().execute(
        {
          userId: CLERK,
          userData: { businessId: OTHER, name: "Carlos Lima Souza" },
        } as never,
        actor,
      );

      const after = users.user.find((u) => u.id === CLERK);

      expect(after?.name).toBe("Carlos Lima Souza");
      expect(after?.businessId).toBe(CARRIER);
    },
  );

  it("refuses the company route for a MASTER account (403)", async () => {
    await expect(
      update().execute(
        { userId: MASTER_TWO, userData: { name: "X" } } as never,
        MASTER,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
  });

  it("refuses an e-mail taken by someone else (409)", async () => {
    await expect(
      update().execute(
        { userId: CLERK, userData: { email: "admin2@a.com.br" } } as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "USER_ALREADY_EXISTS" });
  });

  it("lets only the MASTER send a password setup link", async () => {
    await expect(
      update().execute(
        { userId: CLERK, userData: { sendPasswordSetupLink: true } } as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });

    await update().execute(
      { userId: CLERK, userData: { sendPasswordSetupLink: true } } as never,
      MASTER,
    );
    await settle();

    expect(mail.sent).toEqual([
      expect.objectContaining({
        email: "carlos@a.com.br",
        templateName: "password-reset-by-admin.hbs",
        url: expect.stringMatching(/\/forgot\/password\?token=/),
      }),
    ]);
  });

  it("refuses an unknown person (404)", async () => {
    await expect(
      update().execute(
        {
          userId: "018f3300-0000-7000-8000-0000000000ff",
          userData: { name: "X" },
        } as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
