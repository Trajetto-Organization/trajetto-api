import { afterAll, beforeAll, describe } from "vitest";

import { SessionRepository } from "@/modules/user/repositories/session-repository";
import { InMemorySessionRepository } from "@/modules/user/repositories/in-memory/in-memory-session-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import {
  ALFA,
  BETA,
  BRANCH,
  DRIVERS,
  ENTITLEMENTS,
  FAMILIES,
  PERMISSIONS,
  PROFILES,
  USERS,
  sessionRepositoryContract,
  type SessionHarness,
} from "../contract/repositories/session.contract";
import { KINDS, type Kind } from "../contract/support";
import {
  seedBranch,
  seedBusiness,
  seedDriver,
  seedUser,
} from "../contract/seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Plano-escala F4-04: the session's contract against Postgres (the one
 * statement) and against the twin, fed the same rows.
 */
const prisma = createPrismaClient();

const tokens = new InMemoryUserTokensRepository();
const users = new InMemoryUserRepository({ tokens });

const harnesses: Record<Kind, () => SessionHarness> = {
  prisma: () => ({ kind: "prisma", repo: new SessionRepository(prisma) }),
  "in-memory": () => ({
    kind: "in-memory",
    repo: new InMemorySessionRepository(users, tokens),
  }),
};

const HOUR = 3_600_000;

interface UserRow {
  id: string;
  businessId: string | null;
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  profileAccessId?: string;
  driverId?: string;
  session_version?: number;
}

const USER_ROWS: UserRow[] = [
  { id: USERS.master, businessId: null, role: "MASTER" },
  {
    id: USERS.admin,
    businessId: ALFA,
    role: "BUSINESS_ADMIN",
    session_version: 4,
  },
  {
    id: USERS.profiled,
    businessId: ALFA,
    role: "BUSINESS_USER",
    profileAccessId: PROFILES.full,
  },
  {
    id: USERS.emptyProfile,
    businessId: ALFA,
    role: "BUSINESS_USER",
    profileAccessId: PROFILES.empty,
  },
  {
    id: USERS.driverWithBranch,
    businessId: ALFA,
    role: "BUSINESS_USER",
    driverId: DRIVERS.withBranch,
  },
  {
    id: USERS.driverWithoutBranch,
    businessId: ALFA,
    role: "BUSINESS_USER",
    driverId: DRIVERS.withoutBranch,
  },
  { id: USERS.inactiveCompany, businessId: BETA, role: "BUSINESS_ADMIN" },
];

beforeAll(async () => {
  const now = Date.now();

  await seedBusiness(prisma, ALFA, 1);
  await seedBusiness(prisma, BETA, 2, { is_active: false });

  for (const entitlement of ENTITLEMENTS) {
    await prisma.businessEntitlement.create({
      data: { businessId: ALFA, ...entitlement },
    });
  }

  await prisma.profileAccess.create({
    data: { id: PROFILES.full, name: "Operação", businessId: ALFA },
  });
  await prisma.profileAccess.create({
    data: { id: PROFILES.empty, name: "Vazio", businessId: ALFA },
  });

  for (const permission of PERMISSIONS) {
    await prisma.permission.create({
      data: { ...permission, profileAccessId: PROFILES.full, businessId: ALFA },
    });
  }

  const branch = await seedBranch(prisma, ALFA, 1, BRANCH);

  await prisma.branch.update({
    where: { id: branch.id },
    data: { is_active: false },
  });

  await seedDriver(prisma, ALFA, 1, {
    id: DRIVERS.withBranch,
    branchId: BRANCH,
  });
  await seedDriver(prisma, ALFA, 2, {
    id: DRIVERS.withoutBranch,
    status: "INACTIVE",
  });

  for (const [n, row] of USER_ROWS.entries()) {
    await seedUser(prisma, row.businessId, n + 1, {
      id: row.id,
      role: row.role,
      profileAccessId: row.profileAccessId ?? null,
      driverId: row.driverId ?? null,
      session_version: row.session_version ?? 0,
    });

    users.user.push({
      id: row.id,
      name: `Pessoa Contrato ${n + 1}`,
      email: `pessoa-${n + 1}@contrato.test`,
      password: "hash",
      role: row.role,
      businessId: row.businessId,
      profileAccessId: row.profileAccessId ?? null,
      driverId: row.driverId ?? null,
      access_revoked: false,
      session_version: row.session_version ?? 0,
    });
  }

  const families = [
    { family: FAMILIES.active, userId: USERS.admin, expires: now + 24 * HOUR },
    {
      family: FAMILIES.revoked,
      userId: USERS.admin,
      expires: now + 24 * HOUR,
      revoked: new Date(now - HOUR),
    },
    { family: FAMILIES.expired, userId: USERS.admin, expires: now - HOUR },
    {
      family: FAMILIES.someoneElses,
      userId: USERS.profiled,
      expires: now + 24 * HOUR,
    },
  ];

  for (const [n, item] of families.entries()) {
    const token = {
      id: `5e550600-0000-7000-8000-00000000010${n}`,
      userId: item.userId,
      family_id: item.family,
      token_hash: `hash-do-contrato-de-sessao-${n}`,
      jti: `jti-do-contrato-de-sessao-${n}`,
      expires_in: new Date(item.expires),
      revoked_at: item.revoked ?? null,
    };

    await prisma.refreshToken.create({ data: token });
    tokens.refreshTokenItems.push({ ...token });
  }

  users.businesses.set(ALFA, {
    is_active: true,
    entitlements: ENTITLEMENTS.map((item) => ({ ...item })),
  });
  users.businesses.set(BETA, { is_active: false, entitlements: [] });
  users.profiles.set(PROFILES.full, { name: "Operação", businessId: ALFA });
  users.profiles.set(PROFILES.empty, { name: "Vazio", businessId: ALFA });
  users.profilePermissions.set(
    PROFILES.full,
    PERMISSIONS.map((item) => ({ ...item })),
  );
  users.profilePermissions.set(PROFILES.empty, []);
  users.drivers.set(DRIVERS.withBranch, {
    id: DRIVERS.withBranch,
    status: "ACTIVE",
    businessId: ALFA,
    branchId: BRANCH,
    branch: { is_active: false },
  });
  users.drivers.set(DRIVERS.withoutBranch, {
    id: DRIVERS.withoutBranch,
    status: "INACTIVE",
    businessId: ALFA,
    branchId: null,
    branch: null,
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("session repository (%s)", (kind) => {
  sessionRepositoryContract(harnesses[kind]);
});
