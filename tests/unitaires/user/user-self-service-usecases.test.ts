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
}));

import { compareSecret } from "@/shared/security/bcrypt-gate";
import type { UploadService } from "@/shared/services/upload-service";
import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

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

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  businesses = new InMemoryBusinessRepository();

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
  const change = () => new UpdateUserPasswordUseCase(users);

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
    ).resolves.toBeUndefined();

    await expect(
      compareSecret("senha-nova-456", users.user[0].password),
    ).resolves.toBe(true);
  });
});

describe("turning two-factor authentication on and off", () => {
  const toggle = () => new UpdateTwoFactorAuthenticationUseCase(users);

  it("flips the flag each time", async () => {
    await toggle().execute({ userId: PERSON });
    expect(users.user[0].two_factor_enabled).toBe(true);

    await toggle().execute({ userId: PERSON });
    expect(users.user[0].two_factor_enabled).toBe(false);
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
    const me = await new GetUserUseCase(users, service, businesses).execute(
      MASTER,
    );

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
    const me = await new GetUserUseCase(users, service, businesses).execute(
      PERSON,
    );

    expect(me.enabledModules).toEqual(["FLEET"]);
    expect(me.ai).toEqual({ precheck: false, reason: "not_contracted" });
    expect(me.avatar).toBeNull();
  });

  it("signs the avatar URL", async () => {
    users.user[0].avatar = "avatars/ana.png";

    const { service } = storage();
    const me = await new GetUserUseCase(users, service, businesses).execute(
      PERSON,
    );

    expect(me.avatar).toBe("https://cdn.test/avatars/ana.png?signed");
  });

  it("refuses an unknown caller (404)", async () => {
    const { service } = storage();

    await expect(
      new GetUserUseCase(users, service, businesses).execute(UNKNOWN),
    ).rejects.toMatchObject({ statusCode: 404 });
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
