import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { decode } from "jsonwebtoken";

/**
 * A driver's login without an e-mail (plan of 02/11/2026, D2, second
 * release; decision D02).
 *
 * Many drivers have no mailbox at all, and the e-mail was the one thing the
 * registration demanded of them. Release N loosened User.email (nullable-
 * expand) and taught every reader and every mail flow that it may be null;
 * this release lets the manager register a driver's login without one. The
 * driver signs in with the CPF and the password the manager set, or with the
 * QR code. Everybody else still needs an e-mail.
 */
const mail = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async (props: { templateName: string }) => {
    mail.sent.push(props.templateName);
  },
}));

vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: () => undefined,
  refreshDeliveryRooms: async () => undefined,
  sendCatalogChangedEvent: () => undefined,
}));

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { Driver } from "@/modules/driver/dtos/driver-dto";
import type { NotificationService } from "@/shared/services/notification-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverTrustedDeviceRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-trusted-device-repository";
import { hashDeviceId } from "@/modules/user/services/session-service";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryProfileAccessRepository } from "@/modules/profile-access/repositories/in-memory/in-memory-profile-access-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { CreateUserUseCase } from "@/modules/user/usecases/create-user/create-user-usecase";
import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { createUserSchema } from "@/schemas/create-user-schema";

const CARRIER = "018f3300-0000-7000-8000-00000000020a";
const ADMIN = "018f3300-0000-7000-8000-0000000002a1";
const PROFILE = "018f3300-0000-7000-8000-0000000002b1";
const DRIVER = "018f3300-0000-7000-8000-0000000002d1";
const SECOND_DRIVER = "018f3300-0000-7000-8000-0000000002d2";

const CPF = "52998224725";
const PASSWORD = "Inicial-7781";

const activities = vi.fn(async (_entry: Record<string, unknown>) => undefined);
const notifications = {
  createActivityIfEnabled: activities,
} as unknown as NotificationService;

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let businesses: InMemoryBusinessRepository;
let profiles: InMemoryProfileAccessRepository;
let drivers: InMemoryDriverRepository;

beforeEach(() => {
  mail.sent.length = 0;
  activities.mockClear();

  tokens = new InMemoryUserTokensRepository();
  users = new InMemoryUserRepository({ tokens });
  businesses = new InMemoryBusinessRepository();
  profiles = new InMemoryProfileAccessRepository();
  drivers = new InMemoryDriverRepository();

  users.user.push({
    id: ADMIN,
    name: "Ana Gestora",
    email: "admin@a.com.br",
    password: "x",
    role: "BUSINESS_ADMIN",
    businessId: CARRIER,
    session_version: 0,
    access_revoked: false,
  } as User);

  businesses.business.push({ id: CARRIER } as Business);
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
      id: SECOND_DRIVER,
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the request that creates a user", () => {
  const body = (overrides: Record<string, unknown>) => ({
    name: "Maria Prado",
    role: "BUSINESS_USER",
    businessId: CARRIER,
    ...overrides,
  });

  it("takes a driver's login without an e-mail, absent or blank", () => {
    for (const email of [undefined, ""]) {
      const parsed = createUserSchema.safeParse(
        body({ driverId: DRIVER, password: PASSWORD, email }),
      );

      expect(parsed.success, String(email)).toBe(true);
      expect(parsed.data?.email ?? null).toBeNull();
    }
  });

  it("still demands one from an office user and from an administrator", () => {
    for (const overrides of [
      { profileAccessId: PROFILE },
      { role: "BUSINESS_ADMIN" },
    ]) {
      const parsed = createUserSchema.safeParse(body(overrides));

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed)).toContain("O e-mail é obrigatório.");
    }
  });

  it("still checks an e-mail that is typed", () => {
    const parsed = createUserSchema.safeParse(
      body({ driverId: DRIVER, email: "maria@" }),
    );

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain(
      "O e-mail informado não é válido.",
    );
  });
});

describe("creating a driver's login without an e-mail", () => {
  it("stores no address, mails nothing and says so in the activity", async () => {
    const created = await create().execute(
      {
        name: "Maria Prado",
        email: null,
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: DRIVER,
        password: PASSWORD,
      },
      ADMIN,
    );
    await settle();

    expect(created.email).toBeNull();
    // Nothing to confirm: no address.
    expect(created.email_verified).toBeNull();
    expect(mail.sent).toEqual([]);
    expect(JSON.stringify(activities.mock.calls)).not.toContain(PASSWORD);
  });

  it("lets two of them exist side by side", async () => {
    for (const driverId of [DRIVER, SECOND_DRIVER]) {
      await create().execute(
        {
          name: "Motorista Sem Email",
          email: null,
          role: "BUSINESS_USER",
          businessId: CARRIER,
          driverId,
        },
        ADMIN,
      );
    }

    expect(users.user.filter((user) => user.email === null)).toHaveLength(2);
  });

  // On a phone a QR code already trusted for the login (wave 2), and asked
  // to create the driver's own password: the manager knows this one.
  it("signs in by CPF with the password the manager set, on a trusted phone", async () => {
    const created = await create().execute(
      {
        name: "Maria Prado",
        email: null,
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: DRIVER,
        password: PASSWORD,
      },
      ADMIN,
    );

    users.drivers.set(DRIVER, {
      id: DRIVER,
      status: "ACTIVE",
      businessId: CARRIER,
      branchId: null,
      branch: null,
      cpf: CPF,
    });
    users.businesses.set(CARRIER, {
      is_active: true,
      entitlements: [],
      corporate_reason: "Transportadora A",
    });

    const trusted = new InMemoryDriverTrustedDeviceRepository();
    const phone = "23be03c084165505";

    await trusted.trust({
      userId: created.id,
      deviceHash: hashDeviceId(phone),
      source: "qr",
    });

    const session = await new AuthenticateUserUseCase(
      users,
      tokens,
      drivers,
      trusted,
    ).executeByCpf({ cpf: CPF, password: PASSWORD, deviceId: phone });

    expect(decode(session.token!)).toMatchObject({ sub: created.id });
    expect(session.mustChangePassword).toBe(true);
  });
});
