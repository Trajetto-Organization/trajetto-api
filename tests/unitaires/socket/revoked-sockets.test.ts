import { describe, expect, it } from "vitest";

import {
  createRevokedSubjects,
  hasRevokedSubjects,
  noteRevocation,
  takeRevokedSockets,
} from "@/shared/socket/socket-revalidation";

/**
 * Which local sockets a revocation of the feed re-reads (plano-escala
 * F5-24). A user, a family, a company and a driver are recorded on the
 * socket; a profile and a branch are not, so the pass asks the primary
 * which users they hold (the users of the profile, the logins of the
 * branch's drivers) and re-reads only those sockets. A routine edit of a
 * profile nobody uses re-reads nothing, instead of every socket of the
 * replica. If that read fails, every socket is re-read (fail closed), and
 * a gap still re-reads them all.
 */
function socket(userId: string, extra: Record<string, unknown> = {}) {
  return {
    connected: true,
    data: { userId, sessionId: `f-${userId}`, businessId: "b-1", ...extra },
  };
}

const sockets = [
  socket("u-1"),
  socket("u-2"),
  socket("u-3", { driverId: "d-3" }),
  socket("u-4", { businessId: "b-2" }),
];

const ids = (chosen: Array<{ data: Record<string, unknown> }>) =>
  chosen.map((each) => each.data.userId);

describe("the sockets a revocation re-reads", () => {
  it("are only the users of a profile, read from the database", async () => {
    const subjects = createRevokedSubjects();
    const asked: Array<[string[], string[]]> = [];

    noteRevocation(subjects, "profile", "p-1");

    expect(hasRevokedSubjects(subjects)).toBe(true);

    const chosen = await takeRevokedSockets(
      sockets,
      subjects,
      async (profiles, branches) => {
        asked.push([profiles, branches]);
        return new Set(["u-2"]);
      },
    );

    expect(ids(chosen)).toEqual(["u-2"]);
    expect(asked).toEqual([[["p-1"], []]]);
    expect(hasRevokedSubjects(subjects)).toBe(false);
  });

  it("are only the logins of a branch's drivers, with the other subjects", async () => {
    const subjects = createRevokedSubjects();

    noteRevocation(subjects, "branch", "br-1");
    noteRevocation(subjects, "business", "b-2");

    const chosen = await takeRevokedSockets(
      sockets,
      subjects,
      async (_profiles, branches) =>
        new Set(branches.includes("br-1") ? ["u-3"] : []),
    );

    expect(ids(chosen)).toEqual(["u-3", "u-4"]);
  });

  it("are none for a profile nobody holds", async () => {
    const subjects = createRevokedSubjects();

    noteRevocation(subjects, "profile", "p-new");

    expect(
      await takeRevokedSockets(sockets, subjects, async () => new Set()),
    ).toEqual([]);
  });

  it("are all of them when the database cannot say whose they are", async () => {
    const subjects = createRevokedSubjects();

    noteRevocation(subjects, "profile", "p-1");

    const chosen = await takeRevokedSockets(sockets, subjects, async () => {
      throw new Error("connection refused");
    });

    expect(ids(chosen)).toEqual(["u-1", "u-2", "u-3", "u-4"]);
  });

  it("are all of them on a gap, without asking the database", async () => {
    const subjects = createRevokedSubjects();
    let asked = 0;

    noteRevocation(subjects, "profile", "p-1");
    subjects.everything = true;

    const chosen = await takeRevokedSockets(sockets, subjects, async () => {
      asked += 1;
      return new Set();
    });

    expect(ids(chosen)).toHaveLength(4);
    expect(asked).toBe(0);
  });

  it("never ask the database with nothing of a profile or a branch", async () => {
    const subjects = createRevokedSubjects();
    let asked = 0;

    noteRevocation(subjects, "user", "u-1");
    noteRevocation(subjects, "refresh_family", "f-u-2");
    noteRevocation(subjects, "driver", "d-3");

    const chosen = await takeRevokedSockets(sockets, subjects, async () => {
      asked += 1;
      return new Set();
    });

    expect(ids(chosen)).toEqual(["u-1", "u-2", "u-3"]);
    expect(asked).toBe(0);
  });
});
