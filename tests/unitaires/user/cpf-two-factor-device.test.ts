import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hash } from "bcrypt";
import { decode } from "jsonwebtoken";

/**
 * The second factor of a CPF login stays on the phone the login came from
 * (wave 2, 06/11/2026). The CPF login is accepted on a trusted phone only;
 * its challenge carries that phone's hash, so the code step opens the
 * phone-bound session there and nowhere else — the code cannot carry the
 * CPF login to another device. An e-mail login's challenge names no phone
 * and keeps the session the header asks for.
 */
const codes = vi.hoisted(() => [] as string[]);

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async ({
    additionalVariablesProperties,
  }: {
    additionalVariablesProperties?: { token?: string };
  }) => {
    if (additionalVariablesProperties?.token) {
      codes.push(additionalVariablesProperties.token);
    }
  },
}));

import { AuthenticateUserUseCase } from "@/modules/user/usecases/authenticate-user/authenticate-user-usecase";
import { TwoFactorVerificationUseCase } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-usecase";
import { UserInvalidTwoFactorCodeError } from "@/modules/user/usecases/errors/user-invalid-two-factor-code-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryDriverTrustedDeviceRepository } from "@/modules/user/repositories/in-memory/in-memory-driver-trusted-device-repository";

import { hashDeviceId } from "@/modules/user/services/session-service";

const CPF = "52998224725";
const EMAIL = "maria@exemplo.com.br";
const PASSWORD = "senha-do-motorista";
const PHONE = "23be03c084165505";
const OTHER_PHONE = "9f1c03c084160000";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let login: AuthenticateUserUseCase;
let verification: TwoFactorVerificationUseCase;

beforeEach(async () => {
  codes.length = 0;

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  const trusted = new InMemoryDriverTrustedDeviceRepository();
  const drivers = new InMemoryDriverRepository();

  // What the code step's eligibility check reads (the login by e-mail
  // loads the user without the driver).
  drivers.drivers.push({
    id: "driver-1",
    status: "ACTIVE",
    businessId: "empresa-a",
    branchId: null,
  } as never);

  users.businesses.set("empresa-a", {
    is_active: true,
    entitlements: [],
    corporate_reason: "Transportadora A",
  });
  users.drivers.set("driver-1", {
    id: "driver-1",
    status: "ACTIVE",
    businessId: "empresa-a",
    branchId: null,
    branch: null,
    cpf: CPF,
  });
  users.user.push({
    id: "user-1",
    name: "Maria Prado",
    email: EMAIL,
    password: await hash(PASSWORD, 4),
    role: "BUSINESS_USER",
    businessId: "empresa-a",
    driverId: "driver-1",
    session_version: 0,
    two_factor_enabled: true,
    email_verified: new Date(),
    access_revoked: false,
    must_change_password: true,
  } as never);

  await trusted.trust({
    userId: "user-1",
    deviceHash: hashDeviceId(PHONE),
    source: "qr",
  });

  login = new AuthenticateUserUseCase(
    users as never,
    tokens as never,
    drivers as never,
    trusted,
  );
  verification = new TwoFactorVerificationUseCase(
    users as never,
    tokens as never,
    drivers as never,
  );
});

async function cpfChallenge() {
  const result = await login.executeByCpf({
    cpf: CPF,
    password: PASSWORD,
    deviceId: PHONE,
  });

  return {
    challenge: result.twoFactorChallenge!,
    code: codes[codes.length - 1],
  };
}

describe("a CPF login's code step", () => {
  it("opens the phone-bound session on the phone the login came from", async () => {
    const { challenge, code } = await cpfChallenge();

    const session = await verification.execute(
      { email: EMAIL, twoFactorCode: code, challenge, deviceId: PHONE },
      "mobile",
    );

    expect(decode(session.refresh_token)).toMatchObject({
      sessionClient: "driver_device",
      deviceHash: hashDeviceId(PHONE),
    });
    expect(tokens.refreshTokenItems[0].device_id).toBe(PHONE);
    expect(session.mustChangePassword).toBe(true);
  });

  it("refuses another phone, or none, before counting a guess", async () => {
    const { challenge, code } = await cpfChallenge();

    for (const deviceId of [OTHER_PHONE, undefined]) {
      await expect(
        verification.execute(
          { email: EMAIL, twoFactorCode: code, challenge, deviceId },
          "mobile",
        ),
      ).rejects.toBeInstanceOf(UserInvalidTwoFactorCodeError);
    }

    expect(tokens.twoFactorTokens[0].attempts).toBe(0);
    expect(tokens.refreshTokenItems).toEqual([]);

    // The right phone still finishes it with the same code.
    await expect(
      verification.execute(
        { email: EMAIL, twoFactorCode: code, challenge, deviceId: PHONE },
        "mobile",
      ),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });
});

describe("an e-mail login's code step", () => {
  it("names no phone and keeps the session the header asks for", async () => {
    const result = await login.execute({ email: EMAIL, password: PASSWORD });

    expect(decode(result.twoFactorChallenge!)).not.toHaveProperty("deviceHash");

    const session = await verification.execute(
      {
        email: EMAIL,
        twoFactorCode: codes[codes.length - 1],
        challenge: result.twoFactorChallenge,
        deviceId: PHONE,
      },
      "mobile",
    );

    expect(decode(session.refresh_token)).toMatchObject({
      sessionClient: "mobile",
    });
    expect(tokens.refreshTokenItems[0].device_id).toBeNull();
  });
});
