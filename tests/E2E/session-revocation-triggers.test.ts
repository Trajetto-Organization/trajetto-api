import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { UserTokensRepository } from "@/modules/user/repositories/user-tokens-repository";
import {
  SESSION_REVOCATION_TRIGGERS,
  purgeSessionRevocationLog,
} from "@/shared/auth/session-revocation";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The session revocation log, written by triggers (plano-escala F5-21).
 *
 * The triggers are the only writers of session_revocation_log, and the
 * revocation feed (F5-22) knows of a revocation only through them. So:
 *
 *  - the database's triggers are exactly src/shared/auth/session-revocation
 *    .ts's list: names, tables, events, the columns of each UPDATE and the
 *    kind and subject each writes;
 *  - each covered column, changed, writes one row naming its subject, in
 *    the writer's transaction (a rollback writes nothing);
 *  - what is no revocation writes nothing: a normal refresh rotation, the
 *    purge of an expired or already revoked token, an update of a column
 *    no check reads, and a covered column written with the value it had;
 *  - the log keeps 7 days.
 */
const prisma = createPrismaClient();

const CARRIER = "018fe0c3-0000-7000-8000-00000000000a";
const OTHER = "018fe0c3-0000-7000-8000-00000000000b";

let seed: Awaited<ReturnType<typeof seedFleetDriver>>;
let mark = 0n;

/** The rows written since the last mark, as (kind, subject). */
async function written(): Promise<Array<[string, string]>> {
  const rows = await prisma.$queryRaw<
    Array<{ id: bigint; kind: string; subject_id: string }>
  >`
    SELECT "id", "kind", "subject_id" FROM "session_revocation_log"
    WHERE "id" > ${mark} ORDER BY "id"
  `;

  if (rows.length > 0) mark = rows[rows.length - 1].id;

  return rows.map((row) => [row.kind, row.subject_id]);
}

async function bareBusiness(id: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61000000000000 + Math.floor(Math.random() * 9e6)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `carrier-${randomUUID()}@exemplo.com.br`,
    },
  });
}

async function bareBranch(): Promise<string> {
  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial ${randomUUID().slice(0, 6)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(62000000000000 + Math.floor(Math.random() * 9e6)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-${randomUUID()}@exemplo.com.br`,
      businessId: CARRIER,
    },
  });

  return branch.id;
}

async function bareDriver(branchId: string): Promise<string> {
  const driver = await prisma.driver.create({
    data: {
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().replace(/-/g, "").slice(0, 11),
      cpf: randomUUID().slice(0, 14),
      rg: randomUUID().slice(0, 12),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
      branchId,
    },
  });

  return driver.id;
}

async function bareUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Pessoa",
      email: `revoga-${randomUUID()}@exemplo.com.br`,
      password: "hash-velho",
      role: "BUSINESS_USER",
      businessId: CARRIER,
    },
  });

  return user.id;
}

async function liveToken(
  userId: string,
  familyId: string,
  expiresIn = new Date(Date.now() + 60 * 60 * 1000),
) {
  return prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: expiresIn,
    },
  });
}

beforeAll(async () => {
  seed = await seedFleetDriver(prisma, {
    businessId: CARRIER,
    cnpj: String(63000000000000 + Math.floor(Math.random() * 9e6)),
  });

  await bareBusiness(OTHER);
}, 180_000);

beforeEach(async () => {
  await written();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the database's triggers", () => {
  it("are the list in session-revocation.ts, column by column", async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        name: string;
        table: string;
        type: number;
        columns: string[] | null;
        args: string;
      }>
    >`
      SELECT
        t."tgname" AS "name",
        c."relname" AS "table",
        t."tgtype"::int AS "type",
        (
          SELECT array_agg(a."attname"::text ORDER BY k."ord")
          FROM unnest(t."tgattr") WITH ORDINALITY AS k("attnum", "ord")
          JOIN "pg_attribute" a
            ON a."attrelid" = t."tgrelid" AND a."attnum" = k."attnum"
        ) AS "columns",
        encode(t."tgargs", 'escape') AS "args"
      FROM "pg_trigger" t
      JOIN "pg_class" c ON c."oid" = t."tgrelid"
      JOIN "pg_proc" p ON p."oid" = t."tgfoid"
      WHERE p."proname" = 'trajetto_log_session_revocation'
        AND NOT t."tgisinternal"
      ORDER BY t."tgname"
    `;

    const event = (type: number) =>
      type & 4 ? "INSERT" : type & 8 ? "DELETE" : type & 16 ? "UPDATE" : "?";

    expect(
      rows.map((row) => ({
        name: row.name,
        table: row.table,
        event: event(row.type),
        // Row-level and AFTER (bit 0 set, bit 1 unset).
        rowAfter: (row.type & 1) === 1 && (row.type & 2) === 0,
        columns: row.columns ?? undefined,
        args: row.args.split("\\000").filter(Boolean),
      })),
    ).toEqual(
      [...SESSION_REVOCATION_TRIGGERS]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((trigger) => ({
          name: trigger.name,
          table: trigger.table,
          event: trigger.event,
          rowAfter: true,
          columns: trigger.columns ? [...trigger.columns] : undefined,
          args: [trigger.kind, trigger.subject],
        })),
    );
  });
});

describe("the user", () => {
  it("logs each covered column, the deletion, and nothing else", async () => {
    const userId = await bareUser();
    const driverId = await bareDriver(seed.branchId);
    const profile = await prisma.profileAccess.create({
      data: { name: `Perfil ${randomUUID().slice(0, 6)}`, businessId: CARRIER },
    });

    await written();

    const changes: Array<Record<string, unknown>> = [
      { password: "hash-novo" },
      { access_revoked: true },
      { role: "BUSINESS_ADMIN" },
      { session_version: { increment: 1 } },
      { businessId: OTHER },
      { driverId },
      { profileAccessId: profile.id },
      { anonymized_at: new Date() },
    ];

    for (const data of changes) {
      await prisma.user.update({ where: { id: userId }, data });

      expect(await written(), JSON.stringify(data)).toEqual([["user", userId]]);
    }

    // What every session writes, and a covered column written unchanged.
    await prisma.user.update({
      where: { id: userId },
      data: {
        last_seen_at: new Date(),
        failed_login_attempts: 2,
        name: "Outro nome",
        role: "BUSINESS_ADMIN",
      },
    });

    expect(await written()).toEqual([]);

    await prisma.user.delete({ where: { id: userId } });

    expect(await written()).toEqual([["user", userId]]);
  });

  it("writes nothing when the transaction rolls back", async () => {
    const userId = await bareUser();

    await written();

    await prisma
      .$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { session_version: { increment: 1 } },
        });

        throw new Error("rollback");
      })
      .catch(() => undefined);

    expect(await written()).toEqual([]);
  });
});

describe("the refresh-token family", () => {
  it("is logged when its live token goes, never on a rotation or a purge", async () => {
    const userId = seed.driverUserId;
    const tokens = new UserTokensRepository();

    // A normal rotation, by the repository the refresh route uses.
    const rotating = randomUUID();
    const current = await liveToken(userId, rotating);

    const rotation = await tokens.rotateUserRefreshToken({
      user_id: userId,
      current_jti: current.jti,
      current_token_hash: current.token_hash,
      replacement: {
        userId,
        token_hash: randomUUID(),
        jti: randomUUID(),
        family_id: rotating,
        expires_in: new Date(Date.now() + 60 * 60 * 1000),
      },
      grace_ms: 10_000,
    });

    expect(rotation.outcome).toBe("rotated");
    expect(await written()).toEqual([]);

    // The purge of an expired token, and of the rotated one.
    const expired = randomUUID();

    await liveToken(userId, expired, new Date(Date.now() - 60_000));
    await prisma.refreshToken.deleteMany({ where: { family_id: expired } });
    await prisma.refreshToken.deleteMany({
      where: { family_id: rotating, revoked_at: { not: null } },
    });

    expect(await written()).toEqual([]);

    // Logout: the family deleted, by the repository.
    await tokens.revokeUserRefreshTokenFamily(rotating);

    expect(await written()).toEqual([["refresh_family", rotating]]);

    // Revoked without a successor, straight in the database.
    const revoked = randomUUID();

    await liveToken(userId, revoked);
    await prisma.refreshToken.updateMany({
      where: { family_id: revoked },
      data: { revoked_at: new Date() },
    });

    expect(await written()).toEqual([["refresh_family", revoked]]);
  });
});

describe("the company, its modules, the branch and the driver", () => {
  it("log the company for is_active, the modules and the deletion", async () => {
    await prisma.business.update({
      where: { id: OTHER },
      data: { is_active: false },
    });

    expect(await written()).toEqual([["business", OTHER]]);

    await prisma.business.update({
      where: { id: OTHER },
      data: { is_active: false, telephone: "11888888888" },
    });

    expect(await written()).toEqual([]);

    const entitlement = await prisma.businessEntitlement.create({
      data: { businessId: OTHER, module: "FLEET", enabled: true },
    });

    expect(await written()).toEqual([["business", OTHER]]);

    await prisma.businessEntitlement.update({
      where: { id: entitlement.id },
      data: { enabled: false },
    });

    expect(await written()).toEqual([["business", OTHER]]);

    await prisma.businessEntitlement.delete({ where: { id: entitlement.id } });

    expect(await written()).toEqual([["business", OTHER]]);

    const gone = randomUUID();

    await bareBusiness(gone);
    await written();
    await prisma.business.delete({ where: { id: gone } });

    expect(await written()).toEqual([["business", gone]]);
  });

  it("log the branch and the driver", async () => {
    const branchId = await bareBranch();
    const driverId = await bareDriver(branchId);

    await written();

    await prisma.branch.update({
      where: { id: branchId },
      data: { is_active: false },
    });

    expect(await written()).toEqual([["branch", branchId]]);

    for (const data of [
      { status: "INACTIVE" as const },
      { branchId: seed.branchId },
      { businessId: OTHER },
    ]) {
      await prisma.driver.update({ where: { id: driverId }, data });

      expect(await written(), JSON.stringify(data)).toEqual([
        ["driver", driverId],
      ]);
    }

    await prisma.driver.update({
      where: { id: driverId },
      data: { name: "Outro nome" },
    });

    expect(await written()).toEqual([]);

    await prisma.driver.delete({ where: { id: driverId } });

    expect(await written()).toEqual([["driver", driverId]]);

    await prisma.branch.delete({ where: { id: branchId } });

    expect(await written()).toEqual([["branch", branchId]]);
  });
});

describe("the profile's permissions", () => {
  it("log the profile for a permission added, changed, moved or removed", async () => {
    const profile = await prisma.profileAccess.create({
      data: { name: `Perfil ${randomUUID().slice(0, 6)}`, businessId: CARRIER },
    });
    const other = await prisma.profileAccess.create({
      data: { name: `Perfil ${randomUUID().slice(0, 6)}`, businessId: CARRIER },
    });

    await written();

    const permission = await prisma.permission.create({
      data: {
        action: `Despacho ${randomUUID().slice(0, 6)}`,
        permissionKey: "delivery_manage",
        canRead: true,
        profileAccessId: profile.id,
        businessId: CARRIER,
      },
    });

    expect(await written()).toEqual([["profile", profile.id]]);

    await prisma.permission.update({
      where: { id: permission.id },
      data: { canWrite: true },
    });

    expect(await written()).toEqual([["profile", profile.id]]);

    await prisma.permission.update({
      where: { id: permission.id },
      data: { canWrite: true },
    });

    expect(await written()).toEqual([]);

    // Moved: both profiles' users are affected.
    await prisma.permission.update({
      where: { id: permission.id },
      data: { profileAccessId: other.id },
    });

    expect((await written()).sort()).toEqual(
      [
        ["profile", profile.id],
        ["profile", other.id],
      ].sort(),
    );

    // The profile deleted takes its permission with it: both log it.
    await prisma.profileAccess.delete({ where: { id: other.id } });

    expect(new Set((await written()).map((row) => row.join(":")))).toEqual(
      new Set([`profile:${other.id}`]),
    );
  });
});

describe("the retention", () => {
  it("keeps 7 days", async () => {
    const now = new Date();

    await prisma.$executeRaw`
      INSERT INTO "session_revocation_log" ("kind", "subject_id", "at")
      VALUES
        ('user', 'velho', ${new Date(now.getTime() - 8 * 86_400_000)}),
        ('user', 'recente', ${new Date(now.getTime() - 6 * 86_400_000)})
    `;

    const result = await purgeSessionRevocationLog(prisma, { now });

    expect(result).toMatchObject({ stoppedEarly: false });

    const left = await prisma.$queryRaw<Array<{ subject_id: string }>>`
      SELECT "subject_id" FROM "session_revocation_log"
      WHERE "subject_id" IN ('velho', 'recente')
    `;

    expect(left.map((row) => row.subject_id)).toEqual(["recente"]);
  });
});
