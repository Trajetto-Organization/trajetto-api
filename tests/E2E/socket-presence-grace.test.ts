import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { sign } from "jsonwebtoken";
import {
  Server as LegacySocketServer,
  type Server as SocketIOServer,
} from "socket.io";

import auth from "@/config/auth";
import { env } from "@/env";
import { socketAdapterOptions } from "@/shared/socket/adapter-redis";

import { chatStaffRoom } from "@/modules/chat/usecases/shared/chat-access-rules";
import {
  PRESENCE_ONLINE_WINDOW_MS,
  createPresenceStore,
} from "@/shared/socket/presence";

import { socketClientEntry } from "./support/socket-client";
import { waitForRoom, waitUntil } from "./support/socket-waits";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Chat presence with a wait before "offline", through the real server and
 * Postgres (plano-escala U-05, F4.6).
 *
 * A driver's signal drops for a few seconds all day. Each drop used to be
 * an "offline" and a new "visto por último" on the SAC's screen, then an
 * "online" again. Now the process holding the socket beats the login in
 * `user_presence`, and a login is offline only once its last socket stayed
 * gone for PRESENCE_GRACE_MS (here 2 s, so the clock is the test's: the
 * production default is 45 s). The store's own SQL is checked below on an
 * explicit clock: the 90 s window, the sweep of what a dead process left,
 * and a newer connection's beat that the end of a wait must not take.
 */
const GRACE_MS = 2_000;

vi.hoisted(() => {
  process.env.PRESENCE_GRACE_MS = "2000";
});

const prisma = createPrismaClient();

const CARRIER = "018fd700-0000-7000-8000-0000000c5a01";
const STAFF = "018fd700-0000-7000-8000-0000000c5a11";
const DRIVER_USER = "018fd700-0000-7000-8000-0000000c5a12";
const SWEPT_USER = "018fd700-0000-7000-8000-0000000c5a13";
const DRIVER = "018fd700-0000-7000-8000-0000000c5a21";

interface TestSocket {
  id: string;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
  disconnect: () => void;
}

let server: Server;
let port = 0;
let profileId = "";

let io: typeof import("@/websocket");
let ioServer: SocketIOServer;
let connect: (url: string, options: unknown) => TestSocket;

let staff: TestSocket;

function connectAs(token: string): Promise<TestSocket> {
  return new Promise((done, reject) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(() => reject(new Error("timeout")), 10_000);

    socket.on("connect", () => {
      clearTimeout(timer);
      done(socket);
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function tokenFor(
  userId: string,
  driverId: string | null,
): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    {
      tokenType: "access",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

/** Every chatPresence about the driver the SAC hears from now on. */
function listen(socket: TestSocket) {
  const heard: Array<{ online: boolean; last_seen_at: string | null }> = [];
  const handler = (payload: {
    userId: string;
    online: boolean;
    last_seen_at: string | null;
  }) => {
    if (payload.userId === DRIVER_USER) heard.push(payload);
  };

  socket.on("chatPresence", handler);

  return { heard, stop: () => socket.off("chatPresence", handler) };
}

const lastSeenAt = async (userId = DRIVER_USER) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).last_seen_at;

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora da Presença",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `${Date.now()}${Math.floor(Math.random() * 10)}`.slice(-14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `presenca-${randomUUID()}@example.com`,
    },
  });

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista da Presença",
      birth_date: new Date("1990-01-01"),
      cnh: `CNH${randomUUID().slice(0, 8)}`,
      cpf: `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-11),
      rg: randomUUID().slice(0, 9),
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Atendimento",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: true,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  profileId = profile.id;

  await prisma.user.createMany({
    data: [
      {
        id: STAFF,
        name: "Atendente",
        email: `atendente-${randomUUID()}@example.com`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        profileAccessId: profile.id,
      },
      {
        id: DRIVER_USER,
        name: "Motorista",
        email: `motorista-${randomUUID()}@example.com`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
        driverId: DRIVER,
      },
      {
        id: SWEPT_USER,
        name: "Atendente de outro processo",
        email: `varrido-${randomUUID()}@example.com`,
        password: "nao-usado",
        role: "BUSINESS_USER",
        businessId: CARRIER,
      },
    ],
  });

  server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  ioServer = await io.initializeSocketIO(server);

  ({ io: connect } = await import(/* @vite-ignore */ socketClientEntry()));

  staff = await connectAs(await tokenFor(STAFF, null));
  await waitForRoom(ioServer, staff.id, chatStaffRoom(CARRIER), true);
}, 180_000);

afterAll(async () => {
  staff?.disconnect();

  await io?.shutdownSocketIO();
  await new Promise<void>((done) => server.close(() => done()));

  const users = [STAFF, DRIVER_USER, SWEPT_USER];

  await prisma.userPresence.deleteMany({ where: { user_id: { in: users } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.driver.deleteMany({ where: { id: DRIVER } });
  await prisma.permission.deleteMany({ where: { profileAccessId: profileId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileId } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

describe("the presence store, on an explicit clock", () => {
  const store = createPresenceStore(prisma);
  // In the past, and first in the file: this process's own beat sweeps
  // stale rows about a minute after its boot, and must not find these
  // before the cases below do. Nobody connected is that old.
  const T = new Date("2020-01-01T12:00:00.000Z");
  const at = (ms: number) => new Date(T.getTime() + ms);

  it("reads a beat as online for 90 s, and not a moment longer", async () => {
    expect(await store.beat([{ userId: SWEPT_USER, at: T }], T)).toEqual([
      SWEPT_USER,
    ]);

    expect(
      await store.online([SWEPT_USER], at(PRESENCE_ONLINE_WINDOW_MS - 1)),
    ).toEqual([SWEPT_USER]);
    expect(
      await store.online([SWEPT_USER], at(PRESENCE_ONLINE_WINDOW_MS + 1)),
    ).toEqual([]);
  });

  it("calls a beat on a fresh row no news, and never moves it backwards", async () => {
    expect(
      await store.beat([{ userId: SWEPT_USER, at: at(-5_000) }], at(1_000)),
    ).toEqual([]);

    const row = await prisma.userPresence.findUniqueOrThrow({
      where: { user_id: SWEPT_USER },
    });

    expect(row.heartbeat_at.toISOString()).toBe(T.toISOString());
  });

  it("keeps a newer connection's row when an older socket's wait ends", async () => {
    // Another replica's beat, written after the socket here went at T.
    await store.beat([{ userId: SWEPT_USER, at: at(10_000) }], at(10_000));

    expect(await store.end(SWEPT_USER, T)).toBe(false);
    expect(await lastSeenAt(SWEPT_USER)).toBeNull();
    expect(
      await prisma.userPresence.count({ where: { user_id: SWEPT_USER } }),
    ).toBe(1);
  });

  it("sweeps what a dead process left, stamping its last beat", async () => {
    const lastBeat = at(10_000);
    const swept = await store.sweep(
      new Date(lastBeat.getTime() + PRESENCE_ONLINE_WINDOW_MS + 1),
      1_000,
    );

    expect(swept).toEqual([
      expect.objectContaining({
        userId: SWEPT_USER,
        businessId: CARRIER,
        driverId: null,
      }),
    ]);
    expect((await lastSeenAt(SWEPT_USER))?.toISOString()).toBe(
      lastBeat.toISOString(),
    );
    expect(
      await prisma.userPresence.count({ where: { user_id: SWEPT_USER } }),
    ).toBe(0);
  });

  it("skips a login that does not exist instead of failing the batch", async () => {
    expect(
      await store.beat(
        [
          { userId: randomUUID(), at: T },
          { userId: SWEPT_USER, at: T },
        ],
        T,
      ),
    ).toEqual([SWEPT_USER]);
  });
});

describe("a driver whose signal drops", () => {
  let driver: TestSocket;

  it("comes online once, written before it is announced", async () => {
    const sac = listen(staff);

    try {
      driver = await connectAs(await tokenFor(DRIVER_USER, DRIVER));

      await waitUntil(() => sac.heard.length > 0, "o SAC ouvir o online");

      expect(sac.heard).toEqual([{ ...sac.heard[0], online: true }]);
      expect(
        await prisma.userPresence.count({ where: { user_id: DRIVER_USER } }),
      ).toBe(1);
    } finally {
      sac.stop();
    }
  });

  it(
    "and back within the wait, never went offline: no event, no new 'visto por último'",
    { timeout: 30_000 },
    async () => {
      const sac = listen(staff);

      try {
        driver.disconnect();

        // Gone, and still online for the thread list during the wait.
        expect(await io.getOnlineUserIds([DRIVER_USER])).toEqual([DRIVER_USER]);

        driver = await connectAs(await tokenFor(DRIVER_USER, DRIVER));

        // Past the end of the first wait, with room to spare.
        await new Promise((done) => setTimeout(done, GRACE_MS + 1_500));

        expect(sac.heard).toEqual([]);
        expect(await lastSeenAt()).toBeNull();
        expect(await io.getOnlineUserIds([DRIVER_USER])).toEqual([DRIVER_USER]);
      } finally {
        sac.stop();
      }
    },
  );

  it(
    "and gone for the whole wait, goes offline stamped with when he left",
    { timeout: 30_000 },
    async () => {
      const sac = listen(staff);

      try {
        const leftAround = Date.now();

        driver.disconnect();

        await waitUntil(
          () => sac.heard.length > 0,
          "o SAC ouvir o offline",
          GRACE_MS * 5,
        );

        const [offline] = sac.heard;

        expect(offline.online).toBe(false);

        // Stamped with the moment the socket went, not the end of the wait.
        const stamped = await lastSeenAt();

        expect(stamped?.toISOString()).toBe(offline.last_seen_at);
        expect(stamped!.getTime()).toBeGreaterThanOrEqual(leftAround - 1_000);
        expect(stamped!.getTime()).toBeLessThan(leftAround + GRACE_MS);

        expect(await io.getOnlineUserIds([DRIVER_USER])).toEqual([]);
        expect(
          await prisma.userPresence.count({ where: { user_id: DRIVER_USER } }),
        ).toBe(0);
      } finally {
        sac.stop();
      }
    },
  );
});

describe("a replica of the image before U-05, during the rolling deploy", () => {
  // The previous image holds sockets and never beats presence: its drivers
  // have no row in user_presence. The new replicas answered the thread list
  // from the beats alone, so every driver on the old replica read offline
  // until it drained; before U-05 the list asked every replica. While the
  // adapter has a server that does not beat, the list asks the cluster for
  // the logins the beats did not name.
  it("still shows its drivers online on the thread list", async () => {
    const legacyUser = randomUUID();
    const legacyHttp = createServer();

    await new Promise<void>((done) => legacyHttp.listen(0, "127.0.0.1", done));

    const pub = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    const sub = pub.duplicate();
    const legacy = new LegacySocketServer(legacyHttp, {
      transports: ["websocket"],
    });

    legacy.adapter(createAdapter(pub, sub, socketAdapterOptions(env)));
    legacy.on("connection", async (socket) => {
      const userId = String(socket.handshake.auth.userId);

      socket.data.userId = userId;
      await socket.join(`user:${userId}`);
      socket.emit("joined");
    });

    const client = connect(
      `http://127.0.0.1:${(legacyHttp.address() as AddressInfo).port}`,
      {
        auth: { userId: legacyUser },
        transports: ["websocket"],
        reconnection: false,
      },
    );

    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 10_000);

        client.on("joined", () => {
          clearTimeout(timer);
          done();
        });
      });

      expect(
        await prisma.userPresence.count({ where: { user_id: legacyUser } }),
      ).toBe(0);
      expect(await io.getOnlineUserIds([legacyUser])).toEqual([legacyUser]);
    } finally {
      client.disconnect();
      await new Promise<void>((done) => legacy.close(() => done()));
      pub.disconnect();
      sub.disconnect();
    }
  });
});
