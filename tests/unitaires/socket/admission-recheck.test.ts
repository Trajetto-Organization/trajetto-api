import { describe, expect, it } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import {
  createAdmissionRecheck,
  keepAdmitted,
} from "@/shared/socket/admission-recheck";
import type {
  SocketSubject,
  SubjectRows,
  SweepResult,
} from "@/shared/socket/socket-revalidation";

/**
 * The session read again once a new socket is in its rooms.
 *
 * The handshake reads the session in `io.use`, and Socket.IO joins the rooms
 * only after `next()` and a nextTick. A revocation committed after the read
 * and announced before the join reached no room the socket was in, and it
 * connected with the rights it had before. What closes that gap is ORDER: the
 * read that judges a socket must start after the socket was admitted (after
 * its joins). So the property tested first is that no socket is ever judged
 * by a load that was already running when it arrived.
 */
interface FakeSocket {
  connected: boolean;
  data: Record<string, unknown>;
}

/** What the handshake recorded on `socket.data` (version 0, live family). */
function admittedSocket(userId: string): FakeSocket {
  return {
    connected: true,
    data: {
      userId,
      sessionId: `family-${userId}`,
      sessionVersion: 0,
      role: "BUSINESS_USER",
      businessId: "carrier-1",
      driverId: null,
    },
  };
}

function userRow(id: string, overrides: Partial<User> = {}): User {
  return {
    id,
    role: "BUSINESS_USER",
    email: `${id}@exemplo.com.br`,
    password: "",
    name: "Despachante",
    access_revoked: false,
    session_version: 0,
    businessId: "carrier-1",
    driverId: null,
    business: { is_active: true },
    profileAccess: {
      name: "Despacho",
      permissions: [
        {
          id: `permission-${id}`,
          permissionKey: "delivery_manage",
          action: "Despacho",
          canRead: true,
          canWrite: false,
        },
      ],
    },
    ...overrides,
  };
}

/**
 * The database, as a mutable state, and a load that reads it WHEN CALLED —
 * which is when the real query starts — and answers when the test lets it.
 */
function fakeDatabase(userIds: string[]) {
  const users = new Map(userIds.map((id) => [id, userRow(id)]));
  const families = new Set(userIds.map((id) => `${id}:family-${id}`));

  const events: string[] = [];
  const loads: Array<{
    subjects: SocketSubject[];
    answer: () => void;
    fail: (error: Error) => void;
  }> = [];

  const load = (subjects: SocketSubject[]): Promise<SubjectRows> => {
    events.push(`load ${subjects.map((s) => s.userId).join(",")}`);

    const rows: SubjectRows = {
      users: new Map(
        [...users].map(([id, user]) => [id, structuredClone(user)]),
      ),
      drivers: new Map(),
      activeFamilies: new Set(families),
    };

    return new Promise((resolve, reject) => {
      loads.push({
        subjects,
        answer: () => resolve(rows),
        fail: reject,
      });
    });
  };

  return { users, families, events, loads, load };
}

/** Lets the queue's promise chain run to its next wait. */
const settle = () => new Promise((done) => setImmediate(done));

function recorder() {
  const ended: Array<[string, string]> = [];
  const kept: Array<[string, boolean]> = [];
  const reports: Array<[SweepResult, number]> = [];

  return {
    ended,
    kept,
    reports,
    actions: {
      end: (socket: FakeSocket, reason: string) =>
        ended.push([String(socket.data.userId), reason]),
      keep: (socket: FakeSocket, isDeliveryStaff: boolean) =>
        kept.push([String(socket.data.userId), isDeliveryStaff]),
    },
    report: (result: SweepResult, admitted: number) =>
      reports.push([result, admitted]),
  };
}

describe("the admission recheck", () => {
  it("reads a socket's rows only after admitting it, never in a load already running", async () => {
    const database = fakeDatabase(["a", "b"]);
    const seen = recorder();
    const recheck = createAdmissionRecheck<FakeSocket>({
      load: database.load,
      actions: seen.actions,
      report: seen.report,
    });

    database.events.push("admit a");
    recheck.admit(admittedSocket("a"));

    database.events.push("admit b");
    recheck.admit(admittedSocket("b"));

    // b arrived while a's read was running: that read cannot judge it.
    expect(database.loads.map((load) => load.subjects.length)).toEqual([1]);

    database.loads[0].answer();
    await settle();

    // A second read, started after b was admitted.
    expect(database.events).toEqual(["admit a", "load a", "admit b", "load b"]);

    database.loads[1].answer();
    await settle();

    expect(seen.kept).toEqual([
      ["a", true],
      ["b", true],
    ]);
    expect(seen.ended).toEqual([]);
  });

  it("joins a burst of admissions into one read", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `user-${index}`);
    const database = fakeDatabase(ids);
    const seen = recorder();
    const recheck = createAdmissionRecheck<FakeSocket>({
      load: database.load,
      actions: seen.actions,
      report: seen.report,
    });

    // A replica restarting: one socket, then a hundred while it is read.
    for (const id of ids) recheck.admit(admittedSocket(id));

    database.loads[0].answer();
    await settle();
    database.loads[1].answer();
    await settle();

    expect(database.loads.map((load) => load.subjects.length)).toEqual([
      1, 100,
    ]);
    expect(seen.kept).toHaveLength(101);
    expect(seen.reports.map(([, admitted]) => admitted)).toEqual([1, 100]);
  });

  it.each([
    [
      "the session version moved (password changed, every session ended)",
      (database: ReturnType<typeof fakeDatabase>) => {
        database.users.get("a")!.session_version = 1;
      },
      "user_updated",
    ],
    [
      "the refresh family was revoked (logout, device revoked)",
      (database: ReturnType<typeof fakeDatabase>) => {
        database.families.delete("a:family-a");
      },
      "session_expired",
    ],
    [
      "the company was deactivated",
      (database: ReturnType<typeof fakeDatabase>) => {
        database.users.get("a")!.business = { is_active: false };
      },
      "business_inactive",
    ],
  ] as const)(
    "ends the session when, between the handshake's read and the join, %s",
    async (_label, revoke, reason) => {
      const database = fakeDatabase(["a"]);
      const seen = recorder();
      const recheck = createAdmissionRecheck<FakeSocket>({
        load: database.load,
        actions: seen.actions,
        report: seen.report,
      });

      // The handshake read version 0 and a live family (admittedSocket); the
      // revocation commits now, and its frame found no room to land in.
      revoke(database);

      recheck.admit(admittedSocket("a"));

      database.loads[0].answer();
      await settle();

      expect(seen.ended).toEqual([["a", reason]]);
      expect(seen.kept).toEqual([]);
      expect(seen.reports).toEqual([
        [{ checked: 1, ended: 1, skipped: false }, 1],
      ]);
    },
  );

  it("takes a socket that lost delivery_manage meanwhile out of dispatch, connection kept", async () => {
    const database = fakeDatabase(["a"]);
    const seen = recorder();
    const recheck = createAdmissionRecheck<FakeSocket>({
      load: database.load,
      actions: seen.actions,
    });

    // The handshake decided "dispatch staff"; the permission went before the
    // join, and the room refresh that would have pulled it out found nobody.
    database.users.get("a")!.profileAccess!.permissions![0].canRead = false;

    recheck.admit(admittedSocket("a"));

    database.loads[0].answer();
    await settle();

    expect(seen.kept).toEqual([["a", false]]);
    expect(seen.ended).toEqual([]);
  });

  it("ends nobody when the rows cannot be read, and reads the next admission again", async () => {
    const database = fakeDatabase(["a", "b"]);
    const seen = recorder();
    const recheck = createAdmissionRecheck<FakeSocket>({
      load: database.load,
      actions: seen.actions,
      report: seen.report,
    });

    database.users.get("a")!.session_version = 1;

    recheck.admit(admittedSocket("a"));
    database.loads[0].fail(new Error("Can't reach database server"));
    await settle();

    // Fails open, like the sweep: a server-side disconnect is final in
    // socket.io-client, so a Postgres blip must not drop anyone. The sweep
    // gets this one later.
    expect(seen.ended).toEqual([]);
    expect(seen.reports).toEqual([
      [{ checked: 0, ended: 0, skipped: true }, 1],
    ]);

    // The queue is not stuck behind the failure.
    recheck.admit(admittedSocket("b"));
    database.loads[1].answer();
    await settle();

    expect(seen.kept).toEqual([["b", true]]);
  });

  it("leaves alone a socket that went away while the rows were loading", async () => {
    const database = fakeDatabase(["a"]);
    const seen = recorder();
    const recheck = createAdmissionRecheck<FakeSocket>({
      load: database.load,
      actions: seen.actions,
    });

    database.users.get("a")!.session_version = 1;

    const socket = admittedSocket("a");
    recheck.admit(socket);

    socket.connected = false;
    database.loads[0].answer();
    await settle();

    expect(seen.ended).toEqual([]);
    expect(seen.kept).toEqual([]);
  });

  it("does not read for a socket that left before its turn", async () => {
    const database = fakeDatabase(["a", "b"]);
    const seen = recorder();
    const recheck = createAdmissionRecheck<FakeSocket>({
      load: database.load,
      actions: seen.actions,
    });

    recheck.admit(admittedSocket("a"));

    const gone = admittedSocket("b");
    recheck.admit(gone);
    gone.connected = false;

    database.loads[0].answer();
    await settle();

    // b waited for the next pass and closed meanwhile: nothing to read.
    expect(database.loads).toHaveLength(1);
    expect(seen.kept).toEqual([["a", true]]);
  });

  it("keeps a session whose own password change it adopted while its rows were loading", async () => {
    const database = fakeDatabase(["a"]);
    const seen = recorder();
    const recheck = createAdmissionRecheck<FakeSocket>({
      load: database.load,
      actions: seen.actions,
    });

    const socket = admittedSocket("a");
    recheck.admit(socket);

    // The read already ran with version 0. The session changes its own
    // password and keeps going: the row moves to 1 after that read, and
    // the socket, already in its session room, adopts 1.
    database.users.get("a")!.session_version = 1;
    socket.data.sessionVersion = 1;

    database.loads[0].answer();
    await settle();

    // Before: the adopted 1 against the row's 0, and a live session ended
    // as user_updated.
    expect(seen.ended).toEqual([]);
    expect(seen.kept).toEqual([["a", true]]);
  });

  it("keeps draining after a pass whose action threw", async () => {
    const database = fakeDatabase(["a", "b"]);
    const failures: unknown[] = [];
    const kept: string[] = [];

    const recheck = createAdmissionRecheck<FakeSocket>({
      load: database.load,
      actions: {
        end: () => undefined,
        keep: (socket) => {
          if (socket.data.userId === "a") throw new Error("boom");

          kept.push(String(socket.data.userId));
        },
      },
      fail: (error) => failures.push(error),
    });

    recheck.admit(admittedSocket("a"));
    recheck.admit(admittedSocket("b"));

    database.loads[0].answer();
    await settle();
    database.loads[1].answer();
    await settle();

    expect(failures).toHaveLength(1);
    expect(kept).toEqual(["b"]);
  });
});

describe("what the admission recheck does with a session it keeps", () => {
  /** A socket the handshake judged, and what keepAdmitted did to it. */
  function staffSocket(isDeliveryStaff: boolean) {
    const socket = admittedSocket("a");
    socket.data.isDeliveryStaff = isDeliveryStaff;

    const told: string[] = [];
    const keep = keepAdmitted<FakeSocket>(
      // leaveDeliveryRooms: out of the rooms, the flag off.
      (left) => {
        left.data.isDeliveryStaff = false;
        told.push("left dispatch");
      },
      (_socket, reason) => told.push(reason),
    );

    return { socket, told, keep };
  }

  it("tells a client the dispatch right it lost before its join, once, and takes it out", () => {
    const { socket, told, keep } = staffSocket(true);

    keep(socket, false);

    // The permissions_changed sent to the company's room found this socket
    // in no room; the client re-reads its permissions on this one.
    expect(told).toEqual(["permissions_changed", "left dispatch"]);
    expect(socket.data.isDeliveryStaff).toBe(false);
  });

  it("does not tell it again when the room refresh already took it out", () => {
    const { socket, told, keep } = staffSocket(false);

    keep(socket, false);

    // That refresh came from a frame the socket heard in its company's room.
    expect(told).toEqual(["left dispatch"]);
  });

  it("never hands back a right a newer removal took", () => {
    const { socket, told, keep } = staffSocket(false);

    // Rows read before the removal committed; the refresh it triggered has
    // already taken the socket out.
    keep(socket, true);

    // Back on, the flag alone reopens the SAC's typing hints to the drivers.
    expect(socket.data.isDeliveryStaff).toBe(false);
    expect(told).toEqual([]);
  });

  it("leaves a right still held alone", () => {
    const { socket, told, keep } = staffSocket(true);

    keep(socket, true);

    expect(socket.data.isDeliveryStaff).toBe(true);
    expect(told).toEqual([]);
  });

  it("keeps a removal announced while its rows were loading, through the queue", async () => {
    const database = fakeDatabase(["a"]);
    const { socket, told, keep } = staffSocket(true);
    const recheck = createAdmissionRecheck<FakeSocket>({
      load: database.load,
      actions: { end: () => undefined, keep },
    });

    recheck.admit(socket);

    // The read ran with delivery_manage. Then the admin removes it, and the
    // room refresh finds the socket in its company's room and takes it out.
    database.users.get("a")!.profileAccess!.permissions![0].canRead = false;
    socket.data.isDeliveryStaff = false;

    database.loads[0].answer();
    await settle();

    expect(socket.data.isDeliveryStaff).toBe(false);
    expect(told).toEqual([]);
  });
});
