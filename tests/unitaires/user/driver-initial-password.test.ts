import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { compare } from "bcrypt";

/**
 * The driver's initial password, set by the manager (plan of 02/11/2026, D2;
 * decisions D01 and D04).
 *
 * A driver had to open two e-mails — set the password, then confirm the
 * address — before the first login, and many never did. The manager may now
 * set the password of a DRIVER's login (never an office user's: those keep
 * the single-use link of decision 4.9), hand it over with the CPF, and the
 * driver signs in at once: no e-mail is sent, and the address the manager
 * typed counts as confirmed. The manager may also set a new one later. The
 * password never reaches a mail, a log or the activity feed.
 */
const mail = vi.hoisted(() => ({ sent: [] as string[] }));
const realtime = vi.hoisted(() => ({
  securityEvents: [] as Array<{ userId: string; reason: string }>,
}));

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async (props: { templateName: string }) => {
    mail.sent.push(props.templateName);
  },
}));

vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: (userId: string, payload: { reason: string }) => {
    realtime.securityEvents.push({ userId, reason: payload.reason });
  },
  refreshDeliveryRooms: async () => undefined,
  sendCatalogChangedEvent: () => undefined,
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
import { ResetDriverPasswordUseCase } from "@/modules/user/usecases/reset-driver-password/reset-driver-password-usecase";
import { createUserSchema } from "@/schemas/create-user-schema";
import { resetDriverPasswordSchema } from "@/schemas/reset-driver-password-schema";
import { TENANT_MOVE_REFUSED } from "@/shared/validation/tenant-locked-field";

const CARRIER = "018f3300-0000-7000-8000-00000000010a";
const OTHER = "018f3300-0000-7000-8000-00000000010b";

const ADMIN = "018f3300-0000-7000-8000-0000000001a1";
const OTHER_ADMIN = "018f3300-0000-7000-8000-0000000001a2";
const MASTER = "018f3300-0000-7000-8000-0000000001a3";
const CLERK = "018f3300-0000-7000-8000-0000000001a4";
const DRIVER_LOGIN = "018f3300-0000-7000-8000-0000000001a5";

const PROFILE = "018f3300-0000-7000-8000-0000000001b1";
const DRIVER = "018f3300-0000-7000-8000-0000000001d1";
const LINKED_DRIVER = "018f3300-0000-7000-8000-0000000001d2";

const INITIAL_PASSWORD = "Inicial-7781";

const activities = vi.fn(async (_entry: Record<string, unknown>) => undefined);
const notifications = {
  createActivityIfEnabled: activities,
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
    email_verified: null,
    ...overrides,
  }) as User;

beforeEach(() => {
  mail.sent.length = 0;
  realtime.securityEvents.length = 0;
  activities.mockClear();

  tokens = new InMemoryUserTokensRepository();
  users = new InMemoryUserRepository({ tokens });
  businesses = new InMemoryBusinessRepository();
  profiles = new InMemoryProfileAccessRepository();
  drivers = new InMemoryDriverRepository();

  users.user.push(
    person({
      id: ADMIN,
      name: "Ana Gestora",
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
      id: CLERK,
      email: "carlos@a.com.br",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: PROFILE,
    }),
    person({
      id: DRIVER_LOGIN,
      name: "José Motorista",
      email: "jose@a.com.br",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: LINKED_DRIVER,
    }),
  );

  businesses.business.push(
    { id: CARRIER } as Business,
    { id: OTHER } as Business,
  );
  profiles.profileAccess.push({
    id: PROFILE,
    name: "Operação",
    businessId: CARRIER,
  } as never);
  drivers.drivers.push(
    {
      id: DRIVER,
      name: "João",
      businessId: CARRIER,
      status: "ACTIVE",
    } as Driver,
    {
      id: LINKED_DRIVER,
      name: "José",
      businessId: CARRIER,
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

const reset = () => new ResetDriverPasswordUseCase(users, notifications);

const driverUser = (overrides: Record<string, unknown> = {}) => ({
  name: "Maria Prado",
  email: "maria@a.com.br",
  role: "BUSINESS_USER" as const,
  businessId: CARRIER,
  driverId: DRIVER,
  password: INITIAL_PASSWORD,
  ...overrides,
});

/** Lets the fire-and-forget e-mails and activity settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const everyActivityText = () => JSON.stringify(activities.mock.calls);

describe("creating a driver's login with the password the manager set", () => {
  it("stores that password, confirms the address and sends no e-mail", async () => {
    const created = await create().execute(driverUser() as never, ADMIN);
    await settle();

    expect(await compare(INITIAL_PASSWORD, created.password)).toBe(true);
    expect(created.password).toMatch(/^\$2[aby]\$10\$/);
    expect(created.email_verified).toBeInstanceOf(Date);

    expect(mail.sent).toEqual([]);
    expect(tokens.forgotPasswordVerificationTokens).toHaveLength(0);
  });

  it("records who set it, and never the password itself", async () => {
    await create().execute(driverUser() as never, ADMIN);
    await settle();

    expect(activities).toHaveBeenCalledWith(
      expect.objectContaining({
        performedBy: ADMIN,
        entityId: expect.any(String),
        description: expect.stringContaining("Senha inicial definida"),
      }),
    );
    expect(everyActivityText()).not.toContain(INITIAL_PASSWORD);
  });

  it("keeps the e-mailed link for a driver created without one", async () => {
    const created = await create().execute(
      driverUser({ password: undefined }) as never,
      ADMIN,
    );
    await settle();

    expect(created.email_verified).toBeNull();
    expect(mail.sent).toContain("user-created-successfully.hbs");
  });

  it("refuses a password for anybody but a driver, even past the schema", async () => {
    await expect(
      create().execute(
        driverUser({ driverId: undefined, profileAccessId: PROFILE }) as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "USER_PASSWORD_DRIVER_ONLY",
    });
    expect(users.user.find((user) => user.email === "maria@a.com.br")).toBe(
      undefined,
    );
  });
});

describe("the request that creates a user", () => {
  const body = (overrides: Record<string, unknown>) => ({
    name: "Maria Prado",
    email: "maria@a.com.br",
    role: "BUSINESS_USER",
    businessId: CARRIER,
    ...overrides,
  });

  it("takes a password for a driver's login, with the login's own rule", () => {
    expect(
      createUserSchema.safeParse(
        body({ driverId: DRIVER, password: INITIAL_PASSWORD }),
      ).success,
    ).toBe(true);

    const short = createUserSchema.safeParse(
      body({ driverId: DRIVER, password: "123456" }),
    );

    expect(short.success).toBe(false);
    expect(JSON.stringify(short)).toContain(
      "A senha deve ter pelo menos 7 caracteres.",
    );
  });

  it("refuses a password for an office user or an administrator", () => {
    for (const overrides of [
      { profileAccessId: PROFILE, password: INITIAL_PASSWORD },
      { role: "BUSINESS_ADMIN", password: INITIAL_PASSWORD },
    ]) {
      const parsed = createUserSchema.safeParse(body(overrides));

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed)).toContain(
        "A senha inicial só pode ser definida no login de um motorista.",
      );
    }
  });
});

describe("the manager setting a driver's new password", () => {
  const NEW_PASSWORD = "Nova-Senha-4410";

  it("replaces it, ends the driver's sessions and confirms the address", async () => {
    await tokens.createUserRefreshToken({
      userId: DRIVER_LOGIN,
      token_hash: "hash-1",
      jti: "jti-1",
      family_id: "family-1",
      expires_in: new Date(Date.now() + 60_000),
    });

    await reset().execute({
      actorId: ADMIN,
      userId: DRIVER_LOGIN,
      password: NEW_PASSWORD,
    });
    await settle();

    const row = users.user.find((user) => user.id === DRIVER_LOGIN)!;

    expect(await compare(NEW_PASSWORD, row.password)).toBe(true);
    expect(row.email_verified).toBeInstanceOf(Date);
    expect(row.session_version).toBe(1);
    expect(tokens.refreshTokenItems).toHaveLength(0);
    expect(realtime.securityEvents).toEqual([
      { userId: DRIVER_LOGIN, reason: "password_reset" },
    ]);
    expect(mail.sent).toEqual([]);
  });

  it("records who did it, and never the password", async () => {
    await reset().execute({
      actorId: ADMIN,
      userId: DRIVER_LOGIN,
      password: NEW_PASSWORD,
    });
    await settle();

    expect(activities).toHaveBeenCalledWith(
      expect.objectContaining({ performedBy: ADMIN, entityId: DRIVER_LOGIN }),
    );
    expect(everyActivityText()).not.toContain(NEW_PASSWORD);
  });

  it("answers another company's driver like a missing one (404)", async () => {
    await expect(
      reset().execute({
        actorId: OTHER_ADMIN,
        userId: DRIVER_LOGIN,
        password: NEW_PASSWORD,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });

    await expect(
      reset().execute({
        actorId: ADMIN,
        userId: "018f3300-0000-7000-8000-0000000001ff",
        password: NEW_PASSWORD,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });

    const row = users.user.find((user) => user.id === DRIVER_LOGIN)!;
    expect(row.password).toBe("x");
  });

  it("refuses an office user's password: those keep the e-mailed link", async () => {
    await expect(
      reset().execute({
        actorId: ADMIN,
        userId: CLERK,
        password: NEW_PASSWORD,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "USER_NOT_DRIVER" });
  });

  it("lets the MASTER do it in any company", async () => {
    await reset().execute({
      actorId: MASTER,
      userId: DRIVER_LOGIN,
      password: NEW_PASSWORD,
    });

    const row = users.user.find((user) => user.id === DRIVER_LOGIN)!;
    expect(await compare(NEW_PASSWORD, row.password)).toBe(true);
  });
});

describe("the request that sets a driver's new password", () => {
  // A businessId in an edit body is somebody trying to move the record
  // (decision 16.100): the refusal must be the tenant-move sentence, and it
  // must come first, ahead of the missing password, so the 400 names the
  // real reason (record-company-move-sweep.test.ts sends only businessId).
  it("refuses a businessId with the tenant-move sentence, before asking for the password", () => {
    const parsed = resetDriverPasswordSchema.safeParse({ businessId: OTHER });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues[0].message).toBe(
      TENANT_MOVE_REFUSED,
    );
  });

  it("refuses a businessId even next to a valid password", () => {
    const parsed = resetDriverPasswordSchema.safeParse({
      businessId: CARRIER,
      password: "Nova-Senha-4410",
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
    ).toEqual([TENANT_MOVE_REFUSED]);
  });
});
