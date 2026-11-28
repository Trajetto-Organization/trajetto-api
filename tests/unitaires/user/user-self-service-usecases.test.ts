import { beforeEach, describe, expect, it, vi } from "vitest";

import { hash } from "bcrypt";

/**
 * What a person does to their own account (TEST-UC-1): name, password, 2FA,
 * the forgot-password link check, the session read and the avatar.
 *
 * The mail provider, the websocket and the storage are the boundaries
 * replaced; the account rows live in the in-memory twins.
 */
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ email: string; templateName: string }>,
  fail: false,
}));

const realtime = vi.hoisted(() => ({
  securityEvents: [] as Array<{ userId: string; reason: string }>,
  sessionEvents: [] as Array<{ sessionId: string; reason: string }>,
  adopted: [] as Array<{ sessionId: string; version: number }>,
}));

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async (props: {
    email: string;
    templateName: string;
  }) => {
    if (mail.fail) throw new Error("smtp 421: try again later");
    mail.sent.push({ email: props.email, templateName: props.templateName });
  },
}));

vi.mock("@/websocket", () => ({
  sendSecurityEventToUser: (userId: string, payload: { reason: string }) => {
    realtime.securityEvents.push({ userId, reason: payload.reason });
  },
  sendSecurityEventToSession: (
    sessionId: string,
    payload: { reason: string },
  ) => {
    realtime.sessionEvents.push({ sessionId, reason: payload.reason });
  },
  adoptSessionVersion: (sessionId: string, version: number) => {
    realtime.adopted.push({ sessionId, version });
  },
}));

import { decode } from "jsonwebtoken";
import { v7 as uuidV7 } from "uuid";

import { compareSecret } from "@/shared/security/bcrypt-gate";
import {
  familyStartedAtOf,
  hashDeviceId,
  hashRefreshToken,
} from "@/modules/user/services/session-service";
import type { UploadService } from "@/shared/services/upload-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryBusinessSettingsRepository } from "@/modules/business/repositories/in-memory/in-memory-business-settings-repository";

import { UpdateUserNameUseCase } from "@/modules/user/usecases/update-user-name/update-user-name-usecase";
import { UpdateUserPasswordUseCase } from "@/modules/user/usecases/update-user-password/update-user-password-usecase";
import { UpdateTwoFactorAuthenticationUseCase } from "@/modules/user/usecases/update-two-factor-authentication/update-two-factor-authentication-usecase";
import { ForgotPasswordVerificationUseCase } from "@/modules/user/usecases/forgot-password-verification/forgot-password-verification-usecase";
import { GetUserUseCase } from "@/modules/user/usecases/get-user/get-user-usecase";
import { UploadAvatarUseCase } from "@/modules/user/usecases/upload-avatar/upload-avatar-usecase";
import { DeleteAvatarUseCase } from "@/modules/user/usecases/delete-avatar/delete-avatar-usecase";

const CARRIER = "018f3200-0000-7000-8000-00000000000a";
const PERSON = "018f3200-0000-7000-8000-0000000000a1";
const MASTER = "018f3200-0000-7000-8000-0000000000a3";
const UNKNOWN = "018f3200-0000-7000-8000-0000000000ff";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let businesses: InMemoryBusinessRepository;
let settings: InMemoryBusinessSettingsRepository;

/** The storage boundary, recording what was deleted. */
function storage(overrides: Partial<UploadService> = {}) {
  const deleted: string[] = [];

  const service = {
    resolvePresignedUploads: vi.fn(async (photos: { key: string }[]) =>
      photos.map((photo) => ({ path: `avatars/${PERSON}/${photo.key}` })),
    ),
    deleteFile: vi.fn(async (path: string) => {
      deleted.push(path);
    }),
    getFileUrl: vi.fn(
      async (path: string) => `https://cdn.test/${path}?signed`,
    ),
    ...overrides,
  } as unknown as UploadService;

  return { service, deleted };
}

beforeEach(async () => {
  mail.sent.length = 0;
  mail.fail = false;
  realtime.securityEvents.length = 0;
  realtime.sessionEvents.length = 0;
  realtime.adopted.length = 0;

  tokens = new InMemoryUserTokensRepository();
  users = new InMemoryUserRepository({ tokens });
  businesses = new InMemoryBusinessRepository();
  settings = new InMemoryBusinessSettingsRepository();

  users.user.push(
    {
      id: PERSON,
      name: "Ana Souza",
      email: "ana@transportadora.com.br",
      password: await hash("senha-atual-123", 4),
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
      two_factor_enabled: false,
      session_version: 0,
      avatar: null,
    } as unknown as User,
    {
      id: MASTER,
      name: "Master",
      email: "master@trajetto.com.br",
      password: "x",
      role: "MASTER",
      businessId: null,
    } as unknown as User,
  );
  businesses.business.push({
    id: CARRIER,
    ai_analysis_limit: 0,
  } as unknown as Business);
});

describe("renaming yourself", () => {
  const rename = () => new UpdateUserNameUseCase(users);

  it("stores the new name", async () => {
    await rename().execute({ userId: PERSON, name: "Ana Souza Lima" });

    expect(users.user[0].name).toBe("Ana Souza Lima");
  });

  it("refuses the same name, spaces aside", async () => {
    await expect(
      rename().execute({ userId: PERSON, name: "  Ana Souza " }),
    ).rejects.toMatchObject({ statusCode: 400, code: "USER_NAME_UNCHANGED" });

    expect(users.user[0].name).toBe("Ana Souza");
  });

  it("refuses an unknown caller (404)", async () => {
    await expect(
      rename().execute({ userId: UNKNOWN, name: "Outra" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});

describe("changing your password", () => {
  const change = () => new UpdateUserPasswordUseCase(users, tokens);

  const HOUR = 60 * 60 * 1000;

  /** A live session of PERSON, with a row issued `agoMs` ago. */
  const session = async (
    familyId: string,
    options: {
      deviceId?: string | null;
      agoMs?: number;
      revoked?: boolean;
    } = {},
  ) => {
    const row = await tokens.createUserRefreshToken({
      userId: PERSON,
      token_hash: `hash-${familyId}-${Math.random()}`,
      jti: uuidV7(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 24 * HOUR),
      device_id: options.deviceId ?? null,
    });

    row.created_at = new Date(Date.now() - (options.agoMs ?? 0));
    if (options.revoked) row.revoked_at = new Date();

    return row;
  };

  // Wave 2 (owner's decision): changing the password from the app keeps the
  // current session and ends the others. The change still bumps the version
  // every token is checked against, so this session is re-issued in the same
  // family and the answer carries the new pair; only the OTHER sessions hear
  // password_changed, and this one's sockets adopt the new version.
  it("keeps the caller's session, ends the others, and returns its new pair", async () => {
    const mine = uuidV7();
    const other = uuidV7();

    const old = await session(mine, { agoMs: HOUR });
    await session(other);
    users.pushDeviceTokens.push(
      { userId: PERSON, session_family_id: mine },
      { userId: PERSON, session_family_id: other },
      // From before devices named their session (A9): never this one's.
      { userId: PERSON, session_family_id: null },
    );
    Object.assign(users.user[0], {
      failed_login_attempts: 4,
      failed_login_at: new Date(),
      must_change_password: true,
    });

    const result = await change().execute({
      userId: PERSON,
      currentPassword: "senha-atual-123",
      newPassword: "senha-nova-456",
      sessionId: mine,
      client: "mobile",
    });

    expect(result).toMatchObject({
      token: expect.any(String),
      refresh_token: expect.any(String),
      mustChangePassword: false,
    });
    expect(decode(result.token!)).toMatchObject({
      sub: PERSON,
      familyId: mine,
      sessionVersion: 1,
    });
    expect(decode(result.refresh_token!)).toMatchObject({
      familyId: mine,
      sessionVersion: 1,
      sessionClient: "mobile",
      familyStartedAt: familyStartedAtOf(mine),
    });

    // The other session is gone; this one's live token is deleted (a renewal
    // racing the change finds nothing, instead of reading as reuse) and the
    // new one stored in the same family.
    expect(tokens.refreshTokenItems.map((row) => row.family_id)).toEqual([
      mine,
    ]);
    expect(tokens.refreshTokenItems).not.toContain(old);
    expect(tokens.refreshTokenItems[0].token_hash).toBe(
      hashRefreshToken(result.refresh_token!),
    );
    expect(users.pushDeviceTokens).toEqual([
      { userId: PERSON, session_family_id: mine },
    ]);

    expect(realtime.sessionEvents).toEqual([
      { sessionId: other, reason: "password_changed" },
    ]);
    expect(realtime.securityEvents).toEqual([]);
    expect(realtime.adopted).toEqual([{ sessionId: mine, version: 1 }]);

    expect(users.user[0]).toMatchObject({
      session_version: 1,
      must_change_password: false,
      failed_login_attempts: 0,
      failed_login_at: null,
    });
    await expect(
      compareSecret("senha-nova-456", users.user[0].password),
    ).resolves.toBe(true);
    expect(mail.sent.map((sent) => sent.templateName)).toEqual([
      "user-password-updated.hbs",
    ]);
  });

  it("keeps a phone-bound session bound to the same phone, with its birth", async () => {
    const PHONE = "23be03c084165505";
    const mine = uuidV7();

    await session(mine, { deviceId: PHONE, agoMs: 3 * HOUR });

    // The header never turns a phone session into another policy.
    const result = await change().execute({
      userId: PERSON,
      currentPassword: "senha-atual-123",
      newPassword: "senha-nova-456",
      sessionId: mine,
      client: "web",
    });

    expect(decode(result.refresh_token!)).toMatchObject({
      sessionClient: "driver_device",
      deviceHash: hashDeviceId(PHONE),
      familyStartedAt: familyStartedAtOf(mine),
    });
    expect(
      tokens.refreshTokenItems.find((row) => !row.revoked_at)?.device_id,
    ).toBe(PHONE);
  });

  it("ends every session, as before, when the caller's session is no longer live", async () => {
    const mine = uuidV7();

    await session(mine, { revoked: true });

    const result = await change().execute({
      userId: PERSON,
      currentPassword: "senha-atual-123",
      newPassword: "senha-nova-456",
      sessionId: mine,
    });

    expect(result).toEqual({ mustChangePassword: false });
    expect(tokens.refreshTokenItems).toEqual([]);
    expect(realtime.securityEvents).toEqual([
      { userId: PERSON, reason: "password_changed" },
    ]);
  });

  // The check runs outside the password's write: a logout, the manager's
  // "Revogar este aparelho" or "Aparelhos conectados" landing in between
  // used to be undone — the write stored a new token in the ended session
  // and answered it. Now it is a session no longer live, as above.
  it("does not bring back a session that ends between its check and the write", async () => {
    const mine = uuidV7();
    const other = uuidV7();

    await session(mine, { deviceId: "23be03c084165505" });
    await session(other);

    const check = tokens.findSessionFamily.bind(tokens);
    vi.spyOn(tokens, "findSessionFamily").mockImplementationOnce(
      async (...args) => {
        const family = await check(...args);

        await tokens.revokeUserRefreshTokenFamily(mine);

        return family;
      },
    );

    const result = await change().execute({
      userId: PERSON,
      currentPassword: "senha-atual-123",
      newPassword: "senha-nova-456",
      sessionId: mine,
      client: "mobile",
    });

    expect(result).toEqual({ mustChangePassword: false });
    expect(tokens.refreshTokenItems).toEqual([]);
    expect(realtime.adopted).toEqual([]);
    expect(realtime.securityEvents).toEqual([
      { userId: PERSON, reason: "password_changed" },
    ]);
    // Written once, by the change that ends every session.
    expect(users.user[0].session_version).toBe(1);
    await expect(
      compareSecret("senha-nova-456", users.user[0].password),
    ).resolves.toBe(true);
  });

  it("stores the new hash, ends the other sessions and mails the notice", async () => {
    await change().execute({
      userId: PERSON,
      currentPassword: "senha-atual-123",
      newPassword: "senha-nova-456",
    });

    await expect(
      compareSecret("senha-nova-456", users.user[0].password),
    ).resolves.toBe(true);
    expect(users.user[0].session_version).toBe(1);
    expect(realtime.securityEvents).toEqual([
      { userId: PERSON, reason: "password_changed" },
    ]);
    expect(mail.sent).toEqual([
      {
        email: "ana@transportadora.com.br",
        templateName: "user-password-updated.hbs",
      },
    ]);
  });

  it("refuses a wrong current password and changes nothing", async () => {
    const before = users.user[0].password;

    await expect(
      change().execute({
        userId: PERSON,
        currentPassword: "errada",
        newPassword: "senha-nova-456",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PASSWORD_CURRENT_INCORRECT",
    });

    expect(users.user[0].password).toBe(before);
  });

  it("refuses the current password as the new one", async () => {
    await expect(
      change().execute({
        userId: PERSON,
        currentPassword: "senha-atual-123",
        newPassword: "senha-atual-123",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PASSWORD_SAME_AS_CURRENT",
    });

    expect(users.user[0].session_version).toBe(0);
  });

  it("answers success when only the notice e-mail fails: the password did change", async () => {
    mail.fail = true;

    // The old code awaited the e-mail outside any catch: the provider's
    // failure became a 500 for a password that was already changed, and the
    // person retried with a "current password" that no longer worked.
    await expect(
      change().execute({
        userId: PERSON,
        currentPassword: "senha-atual-123",
        newPassword: "senha-nova-456",
      }),
    ).resolves.toEqual({ mustChangePassword: false });

    await expect(
      compareSecret("senha-nova-456", users.user[0].password),
    ).resolves.toBe(true);
  });
});

describe("turning two-factor authentication on and off", () => {
  const toggle = () => new UpdateTwoFactorAuthenticationUseCase(users);

  // Wave 2: explicit, so a retry after a timeout lands on the same state, and
  // with the current password, so a session somebody else holds cannot turn
  // the factor off.
  it("sets the state asked for, with the current password", async () => {
    await expect(
      toggle().execute({
        userId: PERSON,
        change: { enabled: true, password: "senha-atual-123" },
      }),
    ).resolves.toEqual({ enabled: true, changed: true });
    expect(users.user[0].two_factor_enabled).toBe(true);

    await expect(
      toggle().execute({
        userId: PERSON,
        change: { enabled: false, password: "senha-atual-123" },
      }),
    ).resolves.toEqual({ enabled: false, changed: true });
    expect(users.user[0].two_factor_enabled).toBe(false);
  });

  it("answers the current state again as a no-op: a retry never undoes it", async () => {
    users.user[0].two_factor_enabled = true;
    const write = vi.spyOn(users, "updateTwoFactorAuthentication");

    await expect(
      toggle().execute({
        userId: PERSON,
        change: { enabled: true, password: "senha-atual-123" },
      }),
    ).resolves.toEqual({ enabled: true, changed: false });
    expect(write).not.toHaveBeenCalled();
    expect(users.user[0].two_factor_enabled).toBe(true);
  });

  it("refuses a wrong password like the password change does, and changes nothing", async () => {
    await expect(
      toggle().execute({
        userId: PERSON,
        change: { enabled: true, password: "errada" },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PASSWORD_CURRENT_INCORRECT",
    });
    expect(users.user[0].two_factor_enabled).toBe(false);
  });

  it("refuses turning it on for an account without an e-mail (409)", async () => {
    users.user[0].email = null;

    await expect(
      toggle().execute({
        userId: PERSON,
        change: { enabled: true, password: "senha-atual-123" },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "TWO_FACTOR_REQUIRES_EMAIL",
      message:
        "Para ligar a verificação em duas etapas, cadastre um e-mail na sua conta.",
    });
    expect(users.user[0].two_factor_enabled).toBe(false);
  });

  it("lets an account without an e-mail turn it off", async () => {
    users.user[0].email = null;
    users.user[0].two_factor_enabled = true;

    await expect(
      toggle().execute({
        userId: PERSON,
        change: { enabled: false, password: "senha-atual-123" },
      }),
    ).resolves.toEqual({ enabled: false, changed: true });
  });

  // One release of compatibility: the web image serving during the rollout
  // sends no body. Same refusal without an e-mail.
  it("keeps the old blind toggle when there is no body", async () => {
    await toggle().execute({ userId: PERSON });
    expect(users.user[0].two_factor_enabled).toBe(true);

    await toggle().execute({ userId: PERSON });
    expect(users.user[0].two_factor_enabled).toBe(false);

    users.user[0].email = null;

    await expect(toggle().execute({ userId: PERSON })).rejects.toMatchObject({
      code: "TWO_FACTOR_REQUIRES_EMAIL",
    });
  });

  it("refuses an unknown caller (404)", async () => {
    await expect(toggle().execute({ userId: UNKNOWN })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("checking a forgot-password link", () => {
  const verify = () => new ForgotPasswordVerificationUseCase(users, tokens);

  it("accepts a live token of an existing account", async () => {
    await tokens.createForgotPasswordVerificationToken({
      email: "ana@transportadora.com.br",
      token: "token-vivo",
      expires: new Date(Date.now() + 60_000),
    });

    await expect(verify().execute("token-vivo")).resolves.toBeUndefined();
  });

  it("refuses an unknown token, an expired one and one whose account is gone", async () => {
    await expect(verify().execute("nao-existe")).rejects.toMatchObject({
      statusCode: 400,
      code: "AUTH_TOKEN_INVALID",
    });

    await tokens.createForgotPasswordVerificationToken({
      email: "ana@transportadora.com.br",
      token: "token-vencido",
      expires: new Date(Date.now() - 1_000),
    });
    await expect(verify().execute("token-vencido")).rejects.toMatchObject({
      statusCode: 400,
      code: "AUTH_TOKEN_EXPIRED",
    });

    await tokens.createForgotPasswordVerificationToken({
      email: "saiu@transportadora.com.br",
      token: "token-orfao",
      expires: new Date(Date.now() + 60_000),
    });
    await expect(verify().execute("token-orfao")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("reading your own session (/user/me)", () => {
  it("gives the MASTER every module and no offline pre-check", async () => {
    const { service } = storage();
    const me = await new GetUserUseCase(
      users,
      service,
      businesses,
      settings,
    ).execute(MASTER);

    expect(me.enabledModules).toEqual(expect.arrayContaining(["FLEET"]));
    expect(me.ai).toEqual({ precheck: false, reason: "not_contracted" });
  });

  it("gives a company user only the modules their company has enabled", async () => {
    users.user[0].business = {
      entitlements: [
        { module: "FLEET", enabled: true },
        { module: "DELIVERY", enabled: false },
      ],
    } as never;

    const { service } = storage();
    const me = await new GetUserUseCase(
      users,
      service,
      businesses,
      settings,
    ).execute(PERSON);

    expect(me.enabledModules).toEqual(["FLEET"]);
    expect(me.ai).toEqual({ precheck: false, reason: "not_contracted" });
    expect(me.avatar).toBeNull();
  });

  it("signs the avatar URL", async () => {
    users.user[0].avatar = "avatars/ana.png";

    const { service } = storage();
    const me = await new GetUserUseCase(
      users,
      service,
      businesses,
      settings,
    ).execute(PERSON);

    expect(me.avatar).toBe("https://cdn.test/avatars/ana.png?signed");
  });

  it("refuses an unknown caller (404)", async () => {
    const { service } = storage();

    await expect(
      new GetUserUseCase(users, service, businesses, settings).execute(UNKNOWN),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  /**
   * Plan of 02/11/2026 (M1, M6): the session carries the company's settings,
   * which the app caches for its offline window. A company that never saved
   * reads the defaults; a setting whose module is off reads as its neutral
   * value, and the MASTER belongs to no company.
   */
  it("carries the defaults for a company that never saved its settings", async () => {
    const { service } = storage();
    const me = await new GetUserUseCase(
      users,
      service,
      businesses,
      settings,
    ).execute(PERSON);

    expect(me.businessSettings).toEqual({
      checklist_requirement: "NONE",
      arrival_geofence_mode: "DISABLED",
      arrival_geofence_radius_m: 500,
    });
  });

  it("carries the saved settings, each only while its module is on", async () => {
    await settings.save({
      businessId: CARRIER,
      updatedById: PERSON,
      checklist_requirement: "ROUTE_START_AND_END",
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 300,
    });

    const read = async (modules: string[]) => {
      users.user[0].business = {
        is_active: true,
        entitlements: modules.map((module) => ({ module, enabled: true })),
      };

      const { service } = storage();

      return (
        await new GetUserUseCase(users, service, businesses, settings).execute(
          PERSON,
        )
      ).businessSettings;
    };

    expect(await read(["FLEET", "DELIVERIES"])).toEqual({
      checklist_requirement: "ROUTE_START_AND_END",
      arrival_geofence_mode: "BLOCK",
      arrival_geofence_radius_m: 300,
    });
    // Deliveries without the fleet: no checklist on the route.
    expect(await read(["DELIVERIES"])).toMatchObject({
      checklist_requirement: "NONE",
      arrival_geofence_mode: "BLOCK",
    });
    // The fleet alone: neither applies.
    expect(await read(["FLEET"])).toMatchObject({
      checklist_requirement: "NONE",
      arrival_geofence_mode: "DISABLED",
    });
  });

  it("carries no settings for the MASTER", async () => {
    const { service } = storage();
    const me = await new GetUserUseCase(
      users,
      service,
      businesses,
      settings,
    ).execute(MASTER);

    expect(me.businessSettings).toBeNull();
  });
});

describe("uploading an avatar", () => {
  it("points the account at the new file and only then deletes the old one", async () => {
    users.user[0].avatar = "avatars/old.png";
    const { service, deleted } = storage();

    const updated = await new UploadAvatarUseCase(users, service).execute(
      PERSON,
      {
        key: "new.png",
      },
    );

    expect(users.user[0].avatar).toBe(`avatars/${PERSON}/new.png`);
    expect(updated.avatar).toBe(
      `https://cdn.test/avatars/${PERSON}/new.png?signed`,
    );
    expect(deleted).toEqual(["avatars/old.png"]);
  });

  it("deletes the new file when the account cannot be updated", async () => {
    const { service, deleted } = storage();
    users.updateAvatar = async () => {
      throw new Error("connection reset");
    };

    await expect(
      new UploadAvatarUseCase(users, service).execute(PERSON, {
        key: "new.png",
      }),
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(deleted).toEqual([`avatars/${PERSON}/new.png`]);
  });

  it("never deletes the file the account already points at when signing the answer fails", async () => {
    users.user[0].avatar = "avatars/old.png";
    const { service, deleted } = storage({
      getFileUrl: vi.fn(async () => {
        throw new Error("signing failed");
      }) as never,
    });

    // The old code ran its "clean up the new upload" branch for any failure
    // after the upload — including one AFTER the row was committed. The row
    // then pointed at a file that no longer existed: a broken avatar on
    // every screen until the person uploaded again.
    await new UploadAvatarUseCase(users, service)
      .execute(PERSON, { key: "new.png" })
      .catch(() => undefined);

    expect(users.user[0].avatar).toBe(`avatars/${PERSON}/new.png`);
    expect(deleted).not.toContain(`avatars/${PERSON}/new.png`);
  });

  it("answers success once the account points at the new file, even when signing the URL fails", async () => {
    // Red before: a 500 for an avatar that DID change — the person retried
    // and uploaded again, and the screen said it failed.
    const { service } = storage({
      getFileUrl: vi.fn(async () => {
        throw new Error("signing failed");
      }) as never,
    });

    const updated = await new UploadAvatarUseCase(users, service).execute(
      PERSON,
      { key: "new.png" },
    );

    expect(users.user[0].avatar).toBe(`avatars/${PERSON}/new.png`);
    // No URL to show yet; the next /user/me signs it again.
    expect(updated.avatar).toBeNull();
  });

  it("answers success when only the old file cannot be deleted (the orphan sweep takes it)", async () => {
    users.user[0].avatar = "avatars/old.png";
    const { service } = storage({
      deleteFile: vi.fn(async () => {
        throw new Error("storage unavailable");
      }) as never,
    });

    const updated = await new UploadAvatarUseCase(users, service).execute(
      PERSON,
      { key: "new.png" },
    );

    expect(users.user[0].avatar).toBe(`avatars/${PERSON}/new.png`);
    expect(updated.avatar).toBe(
      `https://cdn.test/avatars/${PERSON}/new.png?signed`,
    );
  });

  it("refuses an unknown caller before touching storage", async () => {
    const { service } = storage();

    await expect(
      new UploadAvatarUseCase(users, service).execute(UNKNOWN, {
        key: "x.png",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(service.resolvePresignedUploads).not.toHaveBeenCalled();
  });
});

describe("removing your avatar", () => {
  it("clears the account and deletes the file", async () => {
    users.user[0].avatar = "avatars/ana.png";
    const { service, deleted } = storage();

    const updated = await new DeleteAvatarUseCase(users, service).execute(
      PERSON,
    );

    expect(updated.avatar).toBeNull();
    expect(users.user[0].avatar).toBeNull();
    expect(deleted).toEqual(["avatars/ana.png"]);
  });

  it("refuses when there is no avatar", async () => {
    const { service } = storage();

    await expect(
      new DeleteAvatarUseCase(users, service).execute(PERSON),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_AVATAR_NOT_FOUND" });
    expect(service.deleteFile).not.toHaveBeenCalled();
  });

  it("keeps the file when the account cannot be updated", async () => {
    users.user[0].avatar = "avatars/ana.png";
    const { service, deleted } = storage();
    users.updateAvatar = async () => {
      throw new Error("connection reset");
    };

    // The old code deleted the file first: a failed update left the row
    // pointing at a file that was already gone.
    await expect(
      new DeleteAvatarUseCase(users, service).execute(PERSON),
    ).rejects.toMatchObject({ statusCode: 500 });

    expect(users.user[0].avatar).toBe("avatars/ana.png");
    expect(deleted).toEqual([]);
  });
});
