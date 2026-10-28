import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Esqueci minha senha" and a flood aimed at one inbox.
 *
 * The route's limit is per CALLER address (4 a minute). An attacker rotating
 * addresses — a botnet, a /64 of IPv6, a proxy pool — met no limit at all on
 * the RECIPIENT side and could bury one chosen person in reset links, each
 * one also revoking the link before it. The use case now claims a 60 s
 * window per recipient (Redis SET NX EX) before doing anything else.
 *
 * What these prove:
 *  - inside the window the caller gets the very same outcome, and nothing is
 *    sent nor stored (no enumeration, no new link);
 *  - the window is claimed for unknown addresses too, before the lookup, so
 *    it cannot tell which e-mails have an account;
 *  - Redis never holds the address: the key is a keyed hash of the
 *    normalized e-mail;
 *  - with Redis down the e-mail still goes out (fail open, ADR 0002).
 */
const mailed: string[] = [];

vi.mock("@/shared/services/transactional-mail-service", () => ({
  sendTransactionalMail: async ({ email }: { email: string }) => {
    mailed.push(email);
  },
}));

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { SendForgotPasswordMailUseCase } from "@/modules/user/usecases/send-forgot-password-mail/send-forgot-password-mail-usecase";
import {
  MAIL_COOLDOWN_SECONDS,
  configureMailCooldown,
  createRedisMailCooldown,
  mailCooldownKey,
  noMailCooldown,
} from "@/shared/security/mail-cooldown";

const EXISTING = "cadastrado@exemplo.com.br";

/**
 * Redis's SET with NX and EX, and nothing else: a key is taken until its TTL
 * runs out. Single-threaded like Redis, so concurrent claims serialize.
 */
function fakeRedis(now: () => number = Date.now) {
  const keys = new Map<string, number>();
  const calls: unknown[][] = [];

  return {
    calls,
    keys,
    async set(...args: unknown[]) {
      calls.push(args);

      const [key, , ex, seconds, nx] = args as [
        string,
        string,
        string,
        number,
        string,
      ];

      expect(ex).toBe("EX");
      expect(nx).toBe("NX");

      const expiresAt = keys.get(key);

      if (expiresAt !== undefined && expiresAt > now()) return null;

      keys.set(key, now() + seconds * 1000);

      return "OK";
    },
  };
}

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let useCase: SendForgotPasswordMailUseCase;

beforeEach(async () => {
  mailed.length = 0;

  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();

  await users.createUser({
    email: EXISTING,
    name: "Pessoa Cadastrada",
    password: "nao-usado",
    role: "BUSINESS_ADMIN",
    businessId: "business-1",
  } as never);

  useCase = new SendForgotPasswordMailUseCase(users, tokens);
});

afterEach(() => {
  configureMailCooldown(noMailCooldown);
  vi.useRealTimers();
});

describe("the cooldown key", () => {
  it("never carries the address, in any spelling", () => {
    const key = mailCooldownKey("forgot-password", "Pessoa.X@Exemplo.com.br");

    expect(key.toLowerCase()).not.toContain("pessoa");
    expect(key.toLowerCase()).not.toContain("exemplo");
    expect(key).toMatch(/^mail-cooldown:[a-z]+:forgot-password:[0-9a-f]{64}$/);
  });

  it("is the same for one address whatever its case and surrounding spaces", () => {
    expect(mailCooldownKey("forgot-password", "  Pessoa@Exemplo.com.BR ")).toBe(
      mailCooldownKey("forgot-password", "pessoa@exemplo.com.br"),
    );
  });

  it("differs between addresses", () => {
    expect(mailCooldownKey("forgot-password", "a@exemplo.com.br")).not.toBe(
      mailCooldownKey("forgot-password", "b@exemplo.com.br"),
    );
  });
});

describe("the Redis cooldown", () => {
  it("arms one window with SET NX EX and refuses inside it", async () => {
    const redis = fakeRedis();
    const cooldown = createRedisMailCooldown(redis);

    expect(await cooldown.claim("forgot-password", EXISTING)).toBe(true);
    expect(await cooldown.claim("forgot-password", EXISTING)).toBe(false);
    expect(redis.calls[0][3]).toBe(MAIL_COOLDOWN_SECONDS);

    // Another recipient has a window of its own.
    expect(
      await cooldown.claim("forgot-password", "outra@exemplo.com.br"),
    ).toBe(true);
  });

  it("lets exactly one of many concurrent claims through", async () => {
    const cooldown = createRedisMailCooldown(fakeRedis());

    const claims = await Promise.all(
      Array.from({ length: 20 }, () =>
        cooldown.claim("forgot-password", EXISTING),
      ),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("fails open when Redis does (down, hung past its command timeout)", async () => {
    const cooldown = createRedisMailCooldown({
      set: async () => {
        throw new Error("Command timed out");
      },
    } as never);

    expect(await cooldown.claim("forgot-password", EXISTING)).toBe(true);
    expect(await cooldown.claim("forgot-password", EXISTING)).toBe(true);
  });
});

describe("forgot password inside the cooldown", () => {
  it("answers the same and sends nothing nor stores a new link", async () => {
    configureMailCooldown(createRedisMailCooldown(fakeRedis()));

    await expect(useCase.execute(EXISTING)).resolves.toBeUndefined();

    const first =
      await tokens.findForgotPasswordVerificationTokenByEmail(EXISTING);

    expect(mailed).toEqual([EXISTING]);

    // Twenty more from "other addresses": the route limit never saw them.
    for (let i = 0; i < 20; i += 1) {
      await expect(useCase.execute(EXISTING)).resolves.toBeUndefined();
    }

    expect(mailed).toEqual([EXISTING]);

    // The link already mailed was not revoked by the flood.
    const after =
      await tokens.findForgotPasswordVerificationTokenByEmail(EXISTING);

    expect(after?.id).toBe(first?.id);
  });

  it("treats another spelling of the address as the same recipient", async () => {
    configureMailCooldown(createRedisMailCooldown(fakeRedis()));

    await useCase.execute(EXISTING);
    await useCase.execute(` ${EXISTING.toUpperCase()} `);

    expect(mailed).toEqual([EXISTING]);
  });

  it("sends again once the window has passed", async () => {
    let clock = 1_000_000;
    configureMailCooldown(createRedisMailCooldown(fakeRedis(() => clock)));

    await useCase.execute(EXISTING);
    clock += MAIL_COOLDOWN_SECONDS * 1000 - 1;
    await useCase.execute(EXISTING);

    expect(mailed).toHaveLength(1);

    clock += 2;
    await useCase.execute(EXISTING);

    expect(mailed).toEqual([EXISTING, EXISTING]);
  });

  it("claims the window for an unknown address as well, before any lookup", async () => {
    const redis = fakeRedis();
    configureMailCooldown(createRedisMailCooldown(redis));

    const lookup = vi.spyOn(users, "findUserByEmail");

    await useCase.execute("ninguem@exemplo.com.br");

    expect(redis.keys.size).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(1);

    // Inside the window: not even the lookup runs, for any address.
    await useCase.execute("ninguem@exemplo.com.br");

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(mailed).toEqual([]);
  });

  it("still sends when Redis is unavailable", async () => {
    configureMailCooldown(
      createRedisMailCooldown({
        set: async () => {
          throw new Error("Connection is closed.");
        },
      } as never),
    );

    await useCase.execute(EXISTING);

    expect(mailed).toEqual([EXISTING]);
  });
});
