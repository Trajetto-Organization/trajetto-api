import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { hash } from "bcrypt";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";

import { ResetUserPasswordUseCase } from "@/modules/user/usecases/reset-user-password/reset-user-password-usecase";

/**
 * One link, one use — under real parallelism.
 *
 * The unit file next to this one proves what the use case decides when the
 * token is already gone. It cannot prove the race, because a fake has no
 * concurrency: it settles every promise on one event loop, in order.
 *
 * These run against Postgres with a SEPARATE `PrismaClient` per attempt. That
 * detail is the test. A single client funnels every query through one
 * connection and serialises the attempts by accident — the fleet-limit race in
 * `write-preconditions.test.ts` passed with the transaction entirely removed
 * until each attempt got its own client.
 */
const prisma = new PrismaClient();

const CARRIER = "018fe000-0000-7000-8000-0000000000b1";

let profileAccessId = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora dos Links",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "10222888000155",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `links-${randomUUID()}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  const profile = await prisma.profileAccess.create({
    data: { name: `Perfil ${randomUUID().slice(0, 8)}`, businessId: CARRIER },
  });

  profileAccessId = profile.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { businessId: CARRIER } });
  await prisma.profileAccess.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

/** A user plus a live token of the given kind, both fresh. */
async function userWithToken(kind: "reset" | "email" | "two-factor") {
  const email = `link-${randomUUID()}@exemplo.com.br`;

  const user = await prisma.user.create({
    data: {
      email,
      name: "Titular do Link",
      password: await hash("a-senha-antiga", 10),
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId,
    },
  });

  const token = randomUUID();
  const expires = new Date(Date.now() + 60 * 60 * 1000);

  if (kind === "reset") {
    const row = await prisma.forgotPasswordVerificationToken.create({
      data: { email, token, expires },
    });

    return { user, email, token, tokenId: row.id };
  }

  if (kind === "email") {
    const row = await prisma.emailVerificationToken.create({
      data: { email, token, expires },
    });

    return { user, email, token, tokenId: row.id };
  }

  const row = await prisma.twoFactorToken.create({
    data: { email, token: await hash("123456", 10), expires },
  });

  return { user, email, token, tokenId: row.id };
}

/** One client per attempt: anything less serialises the race away. */
function racers(count: number): PrismaClient[] {
  return Array.from({ length: count }, () => new PrismaClient());
}

async function release(clients: PrismaClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.$disconnect()));
}

describe("spending a token", () => {
  it("lets exactly one of ten parallel callers spend a reset token", async () => {
    const { tokenId } = await userWithToken("reset");

    const clients = racers(10);

    const won = await Promise.all(
      clients.map((client) =>
        new UserTokensRepository(client)
          .consumeForgotPasswordVerificationToken(tokenId)
          .catch(() => false),
      ),
    );

    await release(clients);

    expect(won.filter(Boolean)).toHaveLength(1);

    expect(
      await prisma.forgotPasswordVerificationToken.count({
        where: { id: tokenId },
      }),
    ).toBe(0);
  });

  it("lets exactly one of ten parallel callers spend an e-mail token", async () => {
    const { tokenId } = await userWithToken("email");

    const clients = racers(10);

    const won = await Promise.all(
      clients.map((client) =>
        new UserTokensRepository(client)
          .consumeEmailVerificationToken(tokenId)
          .catch(() => false),
      ),
    );

    await release(clients);

    expect(won.filter(Boolean)).toHaveLength(1);
  });

  it("lets exactly one of ten parallel callers spend a two-factor code", async () => {
    const { tokenId } = await userWithToken("two-factor");

    const clients = racers(10);

    const won = await Promise.all(
      clients.map((client) =>
        new UserTokensRepository(client)
          .consumeTwoFactorToken(tokenId)
          .catch(() => false),
      ),
    );

    await release(clients);

    expect(won.filter(Boolean)).toHaveLength(1);
  });
});

describe("resetting a password with the same link, eight times at once", () => {
  it("settles on one password, and the losers change nothing", async () => {
    const { user, token, tokenId } = await userWithToken("reset");

    const clients = racers(8);

    /**
     * Eight different passwords, on purpose.
     *
     * With the old `Promise.all` of "update the password" and "delete the
     * token" side by side, every one of these would have written: the row
     * would end up holding whichever query finished last, which is not a
     * decision anybody made. Seven of them must now be refused BEFORE they
     * reach the user row.
     */
    const outcomes = await Promise.all(
      clients.map((client, index) =>
        new ResetUserPasswordUseCase(
          new UserRepository(client),
          new UserTokensRepository(client),
        )
          .execute({ token, password: `senha-do-corredor-${index}` })
          .then(() => index)
          .catch(() => null),
      ),
    );

    await release(clients);

    const winners = outcomes.filter((outcome) => outcome !== null);

    expect(winners).toHaveLength(1);

    // The link is spent, so a ninth attempt has nothing to find.
    expect(
      await prisma.forgotPasswordVerificationToken.count({
        where: { id: tokenId },
      }),
    ).toBe(0);

    /**
     * The password on the row is the WINNER'S, not merely "not the old one".
     *
     * Checking only that it changed would pass even if a loser had overwritten
     * the winner a moment later — which is the exact failure this is here for.
     */
    const settled = await prisma.user.findUnique({ where: { id: user.id } });

    const { compare } = await import("bcrypt");

    expect(
      await compare(`senha-do-corredor-${winners[0]}`, settled!.password),
    ).toBe(true);
  });
});
