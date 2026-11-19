import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AddressInfo } from "node:net";

import { PrismaClient } from "@prisma/client";
import { sign } from "jsonwebtoken";

import auth from "@/config/auth";
import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";

import { APP_BOOT_TIMEOUT_MS } from "../support/app-boot";
import { fixedId } from "../contract/support";
import {
  seedBranch,
  seedBusiness,
  seedDriver,
  seedUser,
} from "../contract/seed";
import { socketClientEntry } from "./support/socket-client";
import { waitUntil } from "./support/socket-waits";

/**
 * What the session costs, and that it refuses the same way through either
 * path (plano-escala F4-05).
 *
 * ensureAuthenticated and the socket handshake read the session on every
 * authenticated request and every connection. The old path asked two
 * repositories: the user with its company and hired modules (and the profile
 * with its permissions, and the driver with its branch), then the
 * refresh-token family — four to six statements before the request did any
 * work of its own. SESSION_LOOKUP_MODE=single (the default) asks one;
 * `legacy` is the old path, kept for two releases as the rollback.
 *
 * Two promises, each in both modes:
 *
 * - the budget: one statement for the session with `single`, over HTTP and
 *   in the handshake (counted on the app's own client: a logging client
 *   replaces the singleton BEFORE the app is imported);
 * - the refusals: every reason a session ends answers the same status and
 *   code, in the same order (a revoked user whose family also ended is
 *   refused as revoked, as before).
 */
const counted = createPrismaClient({
  log: [{ level: "query", emit: "event" }],
});

(globalThis as unknown as { prisma: PrismaClient }).prisma = counted;

const prisma = createPrismaClient();

const MODES = ["single", "legacy"] as const;

type Mode = (typeof MODES)[number];

const ALFA = fixedId("5e55b0", 1);
const BETA = fixedId("5e55b0", 2);
const GAMA = fixedId("5e55b0", 3);

const HOUR = 3_600_000;

const statements: string[] = [];

/** statements.length when the server let each socket in. */
const admitted: number[] = [];

let app: Awaited<typeof import("@/http")>["app"];
let io: typeof import("@/websocket");
let base = "";

type ClientSocket = { on: Function; disconnect: () => void };

let connect: (url: string, options: unknown) => ClientSocket;

interface Session {
  userId: string;
  familyId: string;
  sessionVersion: number;
  claims: { role: string; businessId: string | null; driverId: string | null };
}

const SESSIONS: Record<string, Session> = {};

const initialMode = env.SESSION_LOOKUP_MODE;

function accessToken({
  userId,
  familyId,
  sessionVersion,
  claims,
}: Session): string {
  return sign(
    { tokenType: "access", ...claims, sessionVersion, familyId },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

/**
 * Statements that are work: not the BEGIN/COMMIT around a write, and not
 * the "visto por último" a driver's socket stamps after it is gone, nor
 * the presence beats a socket's connect and disconnect write in a batch
 * (plano-escala U-05), which land whenever they are flushed — in whatever
 * is measured next.
 */
const work = (sql: string[]) =>
  sql.filter(
    (query) =>
      !/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(query) &&
      !/^\s*UPDATE "public"\."user" SET [^;]*"last_seen_at"/i.test(query) &&
      !/"user_presence"/.test(query),
  );

/** The one statement of SessionRepository.loadSession. */
const isSessionStatement = (sql: string) =>
  sql.includes('AS "hasActiveFamily"');

/** POST /user/socket-ticket: the session and a Redis write, nothing else. */
async function overHttp(session: Session) {
  statements.length = 0;

  const response = await app.inject({
    method: "POST",
    url: "/user/socket-ticket",
    headers: { authorization: `Bearer ${accessToken(session)}` },
  });

  return {
    status: response.statusCode,
    code: response.statusCode === 201 ? null : response.json().code,
    statements: work([...statements]),
  };
}

/** "connected" with what the session cost, or the refusal's code. */
function handshake(
  session: Session,
): Promise<{ outcome: string; statements: string[] }> {
  const from = statements.length;
  const seen = admitted.length;

  return new Promise((done) => {
    const socket = connect(base, {
      auth: { token: accessToken(session) },
      transports: ["websocket"],
      reconnection: false,
    });

    socket.on("connect", async () => {
      const cost = work(statements.slice(from, admitted[seen]));

      // The admission recheck reads the session again right after the
      // joins (shared/socket/admission-recheck.ts), its families last. It
      // is not the handshake's, and waited for here so that it does not
      // land inside the next measurement.
      await waitUntil(
        () =>
          statements
            .slice(admitted[seen])
            .some((sql) => sql.includes('"refresh_token"."family_id" IN (')),
        "a reconferência depois do join",
      );

      socket.disconnect();
      done({ outcome: "connected", statements: cost });
    });

    socket.on(
      "connect_error",
      (error: Error & { data?: { code?: string } }) => {
        done({
          outcome: error.data?.code ?? error.message,
          statements: [],
        });
      },
    );
  });
}

async function seedSession(
  name: string,
  businessId: string | null,
  n: number,
  extra: Parameters<typeof seedUser>[3] = {},
  family: { revoked?: boolean; expired?: boolean } = {},
): Promise<void> {
  const user = await seedUser(prisma, businessId, n, extra);
  const familyId = fixedId("5e55b1", n);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      family_id: familyId,
      token_hash: `orcamento-sessao-${n}`,
      jti: `orcamento-sessao-jti-${n}`,
      expires_in: new Date(Date.now() + (family.expired ? -HOUR : 24 * HOUR)),
      revoked_at: family.revoked ? new Date(Date.now() - HOUR) : null,
    },
  });

  SESSIONS[name] = {
    userId: user.id,
    familyId,
    sessionVersion: user.session_version ?? 0,
    claims: {
      role: user.role,
      businessId: user.businessId,
      driverId: user.driverId,
    },
  };
}

beforeAll(async () => {
  counted.$on("query" as never, (event: { query: string }) => {
    statements.push(event.query);
  });

  await seedBusiness(prisma, ALFA, 21);
  await seedBusiness(prisma, BETA, 22, { is_active: false });
  await seedBusiness(prisma, GAMA, 23);

  await prisma.businessEntitlement.create({
    data: { businessId: ALFA, module: "DELIVERIES", enabled: true },
  });

  const operation = await prisma.profileAccess.create({
    data: { name: "Operação", businessId: ALFA },
  });
  const empty = await prisma.profileAccess.create({
    data: { name: "Sem permissões", businessId: ALFA },
  });

  await prisma.permission.create({
    data: {
      permissionKey: "delivery_manage",
      action: "Entregas",
      canRead: true,
      canWrite: true,
      profileAccessId: operation.id,
      businessId: ALFA,
    },
  });

  const branch = await seedBranch(prisma, ALFA, 21);
  const closedBranch = await seedBranch(prisma, ALFA, 22);

  await prisma.branch.update({
    where: { id: closedBranch.id },
    data: { is_active: false },
  });

  const driver = await seedDriver(prisma, ALFA, 21, { branchId: branch.id });
  const inactive = await seedDriver(prisma, ALFA, 22, { status: "INACTIVE" });
  const atClosed = await seedDriver(prisma, ALFA, 23, {
    branchId: closedBranch.id,
  });
  const foreign = await seedDriver(prisma, GAMA, 24);

  // Sessions that pass: one of each shape the lookup joins.
  await seedSession("admin", ALFA, 201, { role: "BUSINESS_ADMIN" });
  await seedSession("operator", ALFA, 202, {
    profileAccessId: operation.id,
  });
  await seedSession("driver", ALFA, 203, { driverId: driver.id });
  await seedSession("master", null, 204, { role: "MASTER" });

  // Sessions that end, one reason each.
  await seedSession("bumped", ALFA, 211, {
    role: "BUSINESS_ADMIN",
    session_version: 1,
  });
  await seedSession(
    "familyRevoked",
    ALFA,
    212,
    { role: "BUSINESS_ADMIN" },
    { revoked: true },
  );
  await seedSession(
    "familyExpired",
    ALFA,
    213,
    { role: "BUSINESS_ADMIN" },
    { expired: true },
  );
  await seedSession("accessRevoked", ALFA, 214, {
    role: "BUSINESS_ADMIN",
    access_revoked: true,
  });
  await seedSession(
    "revokedAndEnded",
    ALFA,
    215,
    { role: "BUSINESS_ADMIN", access_revoked: true },
    { revoked: true },
  );
  await seedSession("noBusiness", null, 216);
  await seedSession("businessInactive", BETA, 217, {
    role: "BUSINESS_ADMIN",
  });
  await seedSession("driverInactive", ALFA, 218, { driverId: inactive.id });
  await seedSession("branchInactive", ALFA, 219, { driverId: atClosed.id });
  await seedSession("foreignDriver", ALFA, 220, { driverId: foreign.id });
  await seedSession("noProfile", ALFA, 221, { profileAccessId: empty.id });

  // The token names version 0; the row moved on.
  SESSIONS.bumped.sessionVersion = 0;

  SESSIONS.gone = {
    userId: fixedId("5e55b2", 1),
    familyId: fixedId("5e55b1", 999),
    sessionVersion: 0,
    claims: { role: "BUSINESS_ADMIN", businessId: ALFA, driverId: null },
  };

  ({ app } = await import("@/http"));
  io = await import("@/websocket");

  await app.listen({ host: "127.0.0.1", port: 0 });

  const ioServer = await io.initializeSocketIO(app.server);

  // Registered after the app's own handler, so it runs once the handshake
  // middleware is done and before any later query of the connection (the
  // admission recheck) can have completed.
  ioServer.on("connection", () => {
    admitted.push(statements.length);
  });

  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  env.SESSION_LOOKUP_MODE = initialMode;

  io?.closeRealtimeConnections();
  await io?.shutdownSocketIO();
  await app?.close();
  await prisma.$disconnect();
  await counted.$disconnect();
});

/**
 * Every reason a session ends, with the answer it has always had. The same
 * list for both modes: a difference between them is a regression of one.
 */
const REFUSALS: Array<[string, number, string, string]> = [
  // name, HTTP status, HTTP code, handshake outcome
  ["gone", 401, "AUTH_SESSION_INVALID", "Usuário não encontrado"],
  ["bumped", 401, "AUTH_SESSION_INVALIDATED", "AUTH_SESSION_INVALIDATED"],
  [
    "familyRevoked",
    401,
    "AUTH_SESSION_INVALIDATED",
    "AUTH_SESSION_INVALIDATED",
  ],
  [
    "familyExpired",
    401,
    "AUTH_SESSION_INVALIDATED",
    "AUTH_SESSION_INVALIDATED",
  ],
  ["accessRevoked", 403, "AUTH_ACCESS_REVOKED", "AUTH_ACCESS_REVOKED"],
  ["revokedAndEnded", 403, "AUTH_ACCESS_REVOKED", "AUTH_ACCESS_REVOKED"],
  ["noBusiness", 403, "AUTH_BUSINESS_REQUIRED", "AUTH_BUSINESS_REQUIRED"],
  ["businessInactive", 403, "AUTH_BUSINESS_INACTIVE", "AUTH_BUSINESS_INACTIVE"],
  ["driverInactive", 403, "AUTH_DRIVER_INACTIVE", "AUTH_DRIVER_INACTIVE"],
  ["branchInactive", 403, "AUTH_BRANCH_INACTIVE", "AUTH_BRANCH_INACTIVE"],
  [
    "foreignDriver",
    403,
    "AUTH_DRIVER_TENANT_MISMATCH",
    "AUTH_DRIVER_TENANT_MISMATCH",
  ],
  [
    "noProfile",
    403,
    "AUTH_PROFILE_NOT_CONFIGURED",
    "AUTH_PROFILE_NOT_CONFIGURED",
  ],
];

const PASSING = ["admin", "operator", "driver", "master"];

describe.each(MODES)("SESSION_LOOKUP_MODE=%s", (mode: Mode) => {
  beforeAll(() => {
    env.SESSION_LOOKUP_MODE = mode;
  });

  it.each(PASSING)("lets the %s in over HTTP", async (name) => {
    const { status, statements: sql } = await overHttp(SESSIONS[name]);
    const trace = sql.join("\n");

    expect(status, trace).toBe(201);

    if (mode === "single") {
      // The route does nothing else with the database: the one statement
      // is the session, whoever the user is.
      expect(sql, trace).toHaveLength(1);
      expect(isSessionStatement(sql[0]), trace).toBe(true);
    } else {
      // The rollback still reads what it always read, and never the
      // one-statement lookup.
      expect(sql.length, trace).toBeGreaterThan(1);
      expect(sql.filter(isSessionStatement), trace).toEqual([]);
    }
  });

  it.each(PASSING)("lets the %s in through the handshake", async (name) => {
    const { outcome, statements: sql } = await handshake(SESSIONS[name]);
    const trace = sql.join("\n");

    expect(outcome).toBe("connected");

    if (mode === "single") {
      expect(sql, trace).toHaveLength(1);
      expect(isSessionStatement(sql[0]), trace).toBe(true);
    } else {
      expect(sql.length, trace).toBeGreaterThan(1);
      expect(sql.filter(isSessionStatement), trace).toEqual([]);
    }
  });

  it.each(REFUSALS)(
    "refuses %s with %i %s",
    async (name, status, code, outcome) => {
      const http = await overHttp(SESSIONS[name]);

      expect({ status: http.status, code: http.code }).toEqual({
        status,
        code,
      });
      expect((await handshake(SESSIONS[name])).outcome).toBe(outcome);

      // A refusal never costs more than a pass: one statement with single.
      if (mode === "single") {
        expect(http.statements, http.statements.join("\n")).toHaveLength(1);
      }
    },
  );
});
