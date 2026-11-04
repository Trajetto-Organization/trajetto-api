import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import type { User } from "@/modules/user/dtos/user-dto";

import { fixedId, KINDS, type Kind } from "../contract/support";
import { seedBusiness, seedUser } from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The barrier of the nullable-expand release of User.email (plan of
 * 02/11/2026, D2; migration 20261102120100). The column takes NULL from this
 * release on, but nothing may write one until the next release enables the
 * driver without an e-mail: the previous image reads the column as required
 * and would fail on such a row (P2032) during the rollout and after a
 * rollback. An edit that carries `email: null` (the web sends whole forms)
 * reads it as "not sent", in Postgres and in the twin alike.
 */
const prisma = createPrismaClient();

const COMPANY = fixedId("0e12", 1);
const ADDRESS = "pessoa-1@contrato.test";

let userId = "";

const memory = new InMemoryUserRepository();

const repositories: Record<
  Kind,
  () => UserRepository | InMemoryUserRepository
> = {
  prisma: () => new UserRepository(prisma),
  "in-memory": () => memory,
};

beforeAll(async () => {
  await seedBusiness(prisma, COMPANY, 1);

  const user = await seedUser(prisma, COMPANY, 1, { role: "BUSINESS_ADMIN" });

  userId = user.id;
  memory.user.push({ ...user } as unknown as User);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("an edit with a null e-mail (%s)", (kind) => {
  it("keeps the stored address and still applies the other fields", async () => {
    const repo = repositories[kind]();

    const updated = await repo.updateUser({
      userId,
      userData: { email: null, name: `Renomeada ${kind}` },
    });

    expect(updated.email).toBe(ADDRESS);
    expect(updated.name).toBe(`Renomeada ${kind}`);
  });
});
