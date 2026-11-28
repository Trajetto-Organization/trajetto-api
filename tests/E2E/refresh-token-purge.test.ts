import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import type { IUsersTokensRepository } from "@/modules/user/repositories/IUsers-tokens-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The expired refresh tokens, purged in batches (plano-escala F1-18).
 *
 * Every refresh writes a row and the access token lives 15 minutes: at the
 * target volume a night has ~1–1.5 M expired rows, and the nightly purge
 * was one deleteMany — one statement against the 30 s statement_timeout,
 * holding the xmin horizon of the whole database while it ran. It now goes
 * oldest first, 5,000 rows a statement, inside the run's budget and a
 * ceiling, and says when expired rows are left (the run is then partial).
 * A live token is never matched.
 *
 * The Prisma repository and its in-memory twin are held to the same
 * answers; the batches are the database's.
 */
const prisma = createPrismaClient();

const USER = randomUUID();

const HOUR_MS = 60 * 60 * 1000;

/** `count` expired tokens of USER, the oldest a day and `count` s back. */
async function seedExpired(count: number): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "refresh_token" ("id", "userId", "token_hash", "jti", "family_id", "expires_in")
    SELECT gen_random_uuid()::text, ${USER}, 'purge-hash-' || g || '-' || gen_random_uuid(),
           'purge-jti-' || g || '-' || gen_random_uuid(), gen_random_uuid()::text,
           now() - interval '1 day' - g * interval '1 second'
    FROM generate_series(1, ${count}::int) g
  `;
}

async function seedLive(count: number): Promise<void> {
  await prisma.refreshToken.createMany({
    data: Array.from({ length: count }, () => ({
      userId: USER,
      token_hash: `live-${randomUUID()}`,
      jti: `live-${randomUUID()}`,
      family_id: randomUUID(),
      expires_in: new Date(Date.now() + 7 * 24 * HOUR_MS),
    })),
  });
}

type Counts = { expired: number; live: number };

async function counts(): Promise<Counts> {
  const [row] = await prisma.$queryRaw<Counts[]>`
    SELECT count(*) FILTER (WHERE "expires_in" < now())::int AS expired,
           count(*) FILTER (WHERE "expires_in" >= now())::int AS live
    FROM "refresh_token" WHERE "userId" = ${USER}
  `;

  return row;
}

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa das Sessões",
      email: `sessoes-${randomUUID()}@example.com`,
      password: "nao-usado",
      role: "MASTER",
    },
  });
}, 60_000);

beforeEach(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.$disconnect();
});

describe("the expired refresh tokens of the Prisma repository", () => {
  it("go in batches of 5,000 and the live ones stay", async () => {
    await seedExpired(12_000);
    await seedLive(3);

    // Every DELETE the purge sends, counted on the repository's own client.
    let deletes = 0;
    const counted = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "$executeRaw") {
          return (...args: Parameters<typeof target.$executeRaw>) => {
            deletes += 1;

            return target.$executeRaw(...args);
          };
        }

        return Reflect.get(target, property, receiver);
      },
    });

    const repository = new UserTokensRepository(counted as never);

    expect(await repository.deleteExpiredUserRefreshTokens()).toEqual({
      deleted: 12_000,
      stoppedEarly: false,
    });
    expect(deletes).toBe(3);
    expect(await counts()).toEqual({ expired: 0, live: 3 });
  });
});

const harnesses: Array<[string, () => IUsersTokensRepository]> = [
  ["prisma", () => new UserTokensRepository()],
  ["in-memory", () => new InMemoryUserTokensRepository()],
];

/** The same rows in the store under test. */
async function seed(
  repository: IUsersTokensRepository,
  expired: number,
  live: number,
): Promise<void> {
  for (let index = 0; index < expired + live; index += 1) {
    await repository.createUserRefreshToken({
      userId: USER,
      token_hash: `contract-${randomUUID()}`,
      jti: `contract-${randomUUID()}`,
      family_id: randomUUID(),
      expires_in: new Date(
        index < expired
          ? Date.now() - (index + 1) * HOUR_MS
          : Date.now() + HOUR_MS,
      ),
    });
  }
}

describe.each(harnesses)("the %s refresh token purge", (_name, make) => {
  it("stops at its ceiling and says expired rows are left", async () => {
    const repository = make();
    await seed(repository, 5, 2);

    const got = await repository.deleteExpiredUserRefreshTokens(new Date(), {
      maxRows: 3,
    });

    expect(got).toEqual({ deleted: 3, stoppedEarly: true });

    // The rest goes on the next call; none of the live ones, ever.
    expect(await repository.deleteExpiredUserRefreshTokens()).toEqual({
      deleted: 2,
      stoppedEarly: false,
    });
  });

  it("is not partial when the ceiling falls on the last expired row", async () => {
    const repository = make();
    await seed(repository, 3, 1);

    const got = await repository.deleteExpiredUserRefreshTokens(new Date(), {
      maxRows: 3,
    });

    expect(got).toEqual({ deleted: 3, stoppedEarly: false });
  });

  it("starts no batch once its deadline passed, and says what is left", async () => {
    const repository = make();
    await seed(repository, 2, 1);

    const got = await repository.deleteExpiredUserRefreshTokens(new Date(), {
      deadline: Date.now() - 1,
    });

    expect(got).toEqual({ deleted: 0, stoppedEarly: true });
  });
});
