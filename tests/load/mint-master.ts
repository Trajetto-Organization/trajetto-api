/**
 * Browser sessions for the screens the fixture cannot reach.
 *
 * `seed.ts` produces fifty BUSINESS_ADMINs and twenty drivers, and their
 * tokens expire in an hour — which is right for a load run and wrong for a
 * browser suite that needs to open /admin. There is no MASTER at all, so the
 * entire back office had no way in, which is a large part of why it had no UI
 * coverage and why two boundary bugs lived there unseen.
 *
 * Nobody's password is touched and nothing is reset: the MASTER row is created
 * in the throwaway `load_test` database if it is not there, and the tokens are
 * signed locally with the same secret the API verifies with. Long-lived on
 * purpose — a suite that fails halfway through because a token aged out
 * reports a product defect that is entirely about the fixture.
 *
 *   DATABASE_URL="...load_test..." npx tsx tests/load/mint-master.ts [out.json]
 *
 * Writes next to the load fixture by default, which is where the browser
 * suite already looks for `load-context.json`.
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

const MASTER_ID = "018fe000-0000-7000-8000-0000000000a1";

const HOURS = 12;

const prisma = new PrismaClient();

/**
 * A signed access token, with the refresh family the guard checks.
 *
 * The family row matters: the API refuses a token whose family it cannot find,
 * so a token minted without one fails authentication for a reason that has
 * nothing to do with the screen under test.
 */
async function tokenFor(
  userId: string,
  role: string,
  businessId: string | null,
): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + HOURS * 60 * 60 * 1000),
    },
  });

  return sign(
    {
      tokenType: "access",
      role,
      businessId,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: `${HOURS}h` },
  );
}

/** A driver's token carries `driverId`, which is what the app reads to know. */
async function driverTokenFor(
  userId: string,
  businessId: string,
  driverId: string,
): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + HOURS * 60 * 60 * 1000),
    },
  });

  return sign(
    {
      tokenType: "access",
      role: "BUSINESS_USER",
      businessId,
      driverId,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: `${HOURS}h` },
  );
}

async function main(): Promise<void> {
  const existing = await prisma.user.findFirst({ where: { role: "MASTER" } });

  const master =
    existing ??
    (await prisma.user.create({
      data: {
        id: MASTER_ID,
        name: "Suporte Trajetto (varredura)",
        email: `sweep-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
    }));

  /**
   * Every manager, not one.
   *
   * The browser suite spreads its specs across fifty users on purpose: socket
   * handshakes are counted per user at thirty a minute, and three workers over
   * forty specs all signing in as the same person spend one budget and the
   * realtime tests start failing about the product for a reason that is
   * entirely about the fixture. That property has to survive here, so this
   * mints one long-lived token per seeded manager rather than a single shared
   * one.
   */
  const admins = await prisma.user.findMany({
    where: { role: "BUSINESS_ADMIN", businessId: { not: null } },
    select: { id: true, businessId: true },
    orderBy: { id: "asc" },
  });

  if (!admins.length || !admins[0].businessId) {
    throw new Error(
      "Nenhum BUSINESS_ADMIN no banco. Rode tests/load/seed.ts antes.",
    );
  }

  const managers: string[] = [];

  for (const admin of admins) {
    managers.push(
      await tokenFor(admin.id, "BUSINESS_ADMIN", admin.businessId as string),
    );
  }

  /**
   * And the drivers, for the same reason.
   *
   * `permission-surfaces.spec.ts` proves that a driver sees none of the
   * office — a security property — by signing in as one. With an aged-out
   * token the app redirects to /login and the spec fails claiming the driver
   * "caiu no login", which reads like the product refusing a valid session.
   */
  const drivers = await prisma.user.findMany({
    where: { role: "BUSINESS_USER", driverId: { not: null } },
    select: { id: true, businessId: true, driverId: true },
    orderBy: { id: "asc" },
    take: 20,
  });

  const driverTokens: string[] = [];

  for (const driver of drivers) {
    driverTokens.push(
      await driverTokenFor(
        driver.id,
        driver.businessId as string,
        driver.driverId as string,
      ),
    );
  }

  const payload = {
    master: await tokenFor(master.id, "MASTER", null),
    manager: managers[0],
    managers,
    drivers: driverTokens,
    masterId: master.id,
    managerId: admins[0].id,
    businessId: admins[0].businessId,
  };

  const out =
    process.argv[2] ??
    resolve(__dirname, "fixtures", "browser-sessions.json");

  writeFileSync(out, JSON.stringify(payload, null, 2));

  console.log(
    `master=${master.id} managers=${managers.length} ` +
      `drivers=${driverTokens.length} business=${admins[0].businessId}`,
  );

  await prisma.$disconnect();
}

void main();
