import "reflect-metadata";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { InMemoryDriverPauseRepository } from "@/modules/driver-pause/repositories/in-memory/in-memory-driver-pause-repository";

import {
  StartDriverPauseUseCase,
  type StartDriverPauseRequest,
} from "@/modules/driver-pause/usecases/start-driver-pause/start-driver-pause-usecase";
import { StartDriverPauseController } from "@/modules/driver-pause/usecases/start-driver-pause/start-driver-pause-controller";
import { EndDriverPauseUseCase } from "@/modules/driver-pause/usecases/end-driver-pause/end-driver-pause-usecase";
import { CurrentDriverPauseUseCase } from "@/modules/driver-pause/usecases/current-driver-pause/current-driver-pause-usecase";
import { CurrentDriverPauseController } from "@/modules/driver-pause/usecases/current-driver-pause/current-driver-pause-controller";
import { PauseCooldownError } from "@/modules/driver-pause/usecases/errors/driver-pause-errors";

import { AppError } from "@/shared/errors/AppError";
import type { ClientVersion } from "@/shared/http/client-version";

import { clearLogged, logged } from "../../support/log-capture";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

/**
 * The 5 minutes between pauses through the use cases, on the in-memory twin
 * (owner, 05/11/2026). Only a NEW start sent now by a build that holds the
 * wait (contract 5 on, no X-Client-Queued-At) is refused, with nothing
 * written; the queue's starts and the older builds are recorded with a warn
 * line; a resend is answered before the rule; an end — even one that
 * creates the pause already closed — is never refused; another driver's or
 * another company's pause never counts; and /current says when the next
 * pause may start.
 */

const COMPANY = "018fe1e6-0000-7000-8000-00000000000a";
const OTHER_COMPANY = "018fe1e6-0000-7000-8000-00000000000b";
const ANA = "018fe1e6-0000-7000-8000-0000000000a1";
const BIA = "018fe1e6-0000-7000-8000-0000000000b2";
const CAIO = "018fe1e6-0000-7000-8000-0000000000c3";

const key = (n: number) =>
  `018fe1e6-0000-7000-8000-${String(n).padStart(12, "0")}`;

const NOW = new Date("2026-11-05T15:00:00.000Z"); // 12:00 in São Paulo
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const CONTRACT_5: ClientVersion = { platform: "android", contract: 5 };
const CONTRACT_4: ClientVersion = { platform: "android", contract: 4 };

const INSIDE_LOG =
  "Pause started inside the cooldown by a queued resend or a build without the rule: recorded";

let repo: InMemoryDriverPauseRepository;
let start: StartDriverPauseUseCase;
let end: EndDriverPauseUseCase;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${error.statusCode} ${error.code}`;
    throw error;
  }

  throw new Error("expected a refusal");
}

/** A pause of the driver, already closed, written straight to the twin. */
async function endedPause(
  n: number,
  endedAt: Date,
  {
    driverId = ANA,
    businessId = COMPANY,
    minutes = 20,
  }: { driverId?: string; businessId?: string; minutes?: number } = {},
) {
  const created = await repo.createPause({
    kind: "REST",
    started_at: new Date(endedAt.getTime() - minutes * MINUTE),
    ended_at: endedAt,
    start_submission_id: key(n),
    end_submission_id: key(1000 + n),
    driverId,
    businessId,
  });

  if (created.status !== "created") throw new Error("seed failed");

  return created.pause;
}

const startAna = (n: number, over: Partial<StartDriverPauseRequest> = {}) =>
  start.execute({
    businessId: COMPANY,
    driverId: ANA,
    kind: "MEAL",
    startSubmissionId: key(n),
    startedAt: NOW,
    now: NOW,
    ...over,
  });

const insideLines = () =>
  logged("warn").filter((line) => line.msg === INSIDE_LOG);

beforeEach(() => {
  clearLogged();

  repo = new InMemoryDriverPauseRepository(
    [],
    [],
    [
      { id: ANA, businessId: COMPANY, name: "Ana" },
      { id: BIA, businessId: COMPANY, name: "Bia" },
      { id: CAIO, businessId: COMPANY, name: "Caio" },
    ],
    [
      { id: COMPANY, timezone: "America/Sao_Paulo" },
      { id: OTHER_COMPANY, timezone: "America/Manaus" },
    ],
  );

  // Ana and Bia are on the street (decision 14.4); Caio has no journey.
  for (const driverId of [ANA, BIA]) {
    repo.routes.push({
      id: `journey-${driverId}`,
      businessId: COMPANY,
      driverId,
      status: "IN_PROGRESS",
      released_at: new Date("2026-11-01T10:00:00.000Z"),
      started_at: new Date("2026-11-01T11:00:00.000Z"),
      completed_at: null,
      updated_at: new Date("2026-11-01T11:00:00.000Z"),
      scheduled_date: "2026-11-01",
    });
  }

  start = new StartDriverPauseUseCase(repo);
  end = new EndDriverPauseUseCase(repo);
});

describe("a new start from a build that holds the wait, sent now", () => {
  it("is refused inside the cooldown with when the next may start, and nothing is written", async () => {
    await endedPause(1, ago(2 * MINUTE));

    const error = await startAna(2, { client: CONTRACT_5 }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PauseCooldownError);
    expect(error).toMatchObject({
      statusCode: 409,
      code: "PAUSE_COOLDOWN",
      message:
        "Você encerrou uma pausa às 11:58. Uma nova pausa fica disponível às 12:03.",
      cooldown: {
        last_ended_at: ago(2 * MINUTE).toISOString(),
        next_pause_allowed_at: new Date(
          NOW.getTime() + 3 * MINUTE,
        ).toISOString(),
        next_pause_in_seconds: 180,
      },
    });
    expect(repo.pauses).toHaveLength(1);
    expect(await repo.findByStartSubmission(COMPANY, key(2))).toBeNull();
    expect(insideLines()).toEqual([]);
  });

  it("is refused at 4:29.999 after the end and taken at 4:30 (30 s of slack)", async () => {
    await endedPause(1, ago(4 * MINUTE + 29 * SECOND + 999));

    expect(await codeOf(startAna(2, { client: CONTRACT_5 }))).toBe(
      "409 PAUSE_COOLDOWN",
    );

    repo.pauses = [];
    await endedPause(1, ago(4 * MINUTE + 30 * SECOND));

    const taken = await startAna(2, { client: CONTRACT_5 });

    expect(taken.replayed).toBe(false);
    // Outside the cooldown by the server's rule: nothing to report.
    expect(insideLines()).toEqual([]);
  });

  it("is taken once 5 minutes passed, from any later build too", async () => {
    await endedPause(1, ago(5 * MINUTE));

    expect((await startAna(2, { client: CONTRACT_5 })).replayed).toBe(false);

    await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(2),
      endSubmissionId: key(102),
      endedAt: new Date(NOW.getTime() + 10 * MINUTE),
      now: new Date(NOW.getTime() + 10 * MINUTE),
    });

    const later = new Date(NOW.getTime() + 16 * MINUTE);

    expect(
      (
        await startAna(3, {
          client: { contract: 6 },
          startedAt: later,
          now: later,
        })
      ).replayed,
    ).toBe(false);
    expect(insideLines()).toEqual([]);
  });

  it("is refused for a tap before the previous end (a negative gap)", async () => {
    // Previous pause: 11:50 → 11:59; the corrected tap says 11:58.
    await endedPause(1, ago(MINUTE), { minutes: 9 });

    expect(
      await codeOf(
        startAna(2, { client: CONTRACT_5, startedAt: ago(2 * MINUTE) }),
      ),
    ).toBe("409 PAUSE_COOLDOWN");
    expect(repo.pauses).toHaveLength(1);
  });

  it("is measured from the pause that ended before the tap, not from one that started after it", async () => {
    // Ended 2 min ago, but started after this start's tap: not "previous".
    await endedPause(1, ago(2 * MINUTE), { minutes: 3 });

    const taken = await startAna(2, {
      client: CONTRACT_5,
      startedAt: ago(30 * MINUTE),
    });

    expect(taken.replayed).toBe(false);
  });

  it("lets a more fundamental refusal win: no journey, too old, another pause open", async () => {
    await endedPause(1, ago(MINUTE), { driverId: CAIO });

    expect(
      await codeOf(
        start.execute({
          businessId: COMPANY,
          driverId: CAIO,
          kind: "REST",
          startSubmissionId: key(2),
          startedAt: NOW,
          client: CONTRACT_5,
          now: NOW,
        }),
      ),
    ).toBe("409 PAUSE_REQUIRES_ROUTE");

    await endedPause(3, ago(MINUTE));

    expect(
      await codeOf(
        startAna(4, { client: CONTRACT_5, startedAt: null, staleTap: true }),
      ),
    ).toBe("409 PAUSE_TOO_OLD");

    // The queue's start got in inside the cooldown and is still open: the
    // app's state is stale, and the answer that tells it so wins.
    await startAna(5, {
      client: CONTRACT_5,
      queued: true,
      startedAt: ago(30 * SECOND),
    });

    expect(await codeOf(startAna(6, { client: CONTRACT_5 }))).toBe(
      "409 PAUSE_ALREADY_OPEN",
    );
  });
});

describe("a start the server records inside the cooldown", () => {
  it("from the offline queue (X-Client-Queued-At), with a warn line", async () => {
    const previous = await endedPause(1, ago(MINUTE));

    const taken = await startAna(2, { client: CONTRACT_5, queued: true });

    expect(taken.replayed).toBe(false);
    expect(insideLines()).toEqual([
      expect.objectContaining({
        component: "driver-pause",
        pauseId: taken.pause.id,
        previousPauseId: previous.id,
        businessId: COMPANY,
        driverId: ANA,
        clientContract: 5,
        queued: true,
      }),
    ]);
  });

  it("from a build without the contract header (the web, mobile main) or below contract 5", async () => {
    await endedPause(1, ago(2 * MINUTE));

    const bare = await startAna(2, { startedAt: ago(MINUTE) });

    expect(bare.replayed).toBe(false);

    await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(2),
      endSubmissionId: key(102),
      endedAt: ago(30 * SECOND),
      now: NOW,
    });

    const older = await startAna(3, { client: CONTRACT_4 });

    expect(older.replayed).toBe(false);
    expect(
      insideLines().map((line) => [line.clientContract, line.queued]),
    ).toEqual([
      [null, false],
      [4, false],
    ]);
  });

  it("writes no line for a resend, nor for a start refused later", async () => {
    await endedPause(1, ago(MINUTE));
    await startAna(2, { queued: true, client: CONTRACT_5 });

    clearLogged();

    // The resend, then another key while that pause is open.
    expect((await startAna(2, { client: CONTRACT_5 })).replayed).toBe(true);
    expect(await codeOf(startAna(3, { client: CONTRACT_4 }))).toBe(
      "409 PAUSE_ALREADY_OPEN",
    );
    expect(insideLines()).toEqual([]);
  });

  it("never logs the driver's note or position", async () => {
    await endedPause(1, ago(MINUTE));
    await startAna(2, {
      note: "Almoço no posto",
      latitude: -23.55,
      longitude: -46.63,
    });

    const [line] = insideLines();

    expect(JSON.stringify(line)).not.toContain("Almoço");
    expect(JSON.stringify(line)).not.toContain("-23.55");
  });
});

describe("what the cooldown never refuses", () => {
  it("a resend of a start that got in, even inside the cooldown and sent now", async () => {
    // The pause itself, started and ended: its own start resent after.
    const started = await startAna(1, {
      client: CONTRACT_5,
      startedAt: ago(10 * MINUTE),
    });
    await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: ago(MINUTE),
      now: NOW,
    });

    const again = await startAna(1, { client: CONTRACT_5 });

    expect(again.replayed).toBe(true);
    expect(again.pause.id).toBe(started.pause.id);

    // A start the queue got in inside the cooldown, resent directly.
    const queued = await startAna(2, { client: CONTRACT_5, queued: true });
    const resent = await startAna(2, { client: CONTRACT_5 });

    expect(resent).toMatchObject({
      replayed: true,
      pause: { id: queued.pause.id },
    });
  });

  it("an end, however soon after the previous pause", async () => {
    await endedPause(1, ago(3 * MINUTE));
    await startAna(2, {
      client: CONTRACT_5,
      queued: true,
      startedAt: ago(2 * MINUTE),
    });

    const closed = await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(2),
      endSubmissionId: key(102),
      endedAt: ago(MINUTE),
      now: NOW,
    });

    expect(closed.pause.ended_at).toEqual(ago(MINUTE));
  });

  it("an end that arrives before its start and creates the pause closed, and the late start then finds it", async () => {
    await endedPause(1, ago(3 * MINUTE));

    const created = await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(2),
      endSubmissionId: key(102),
      endedAt: ago(30 * SECOND),
      start: { kind: "REST", startedAt: ago(2 * MINUTE) },
      now: NOW,
    });

    expect(created.replayed).toBe(false);
    expect(created.pause.started_at).toEqual(ago(2 * MINUTE));

    const late = await startAna(2, {
      client: CONTRACT_5,
      startedAt: ago(2 * MINUTE),
    });

    expect(late).toMatchObject({
      replayed: true,
      pause: { id: created.pause.id },
    });
  });
});

describe("whose pause counts", () => {
  it("never another driver's, nor the same driver's in another company", async () => {
    await endedPause(1, ago(MINUTE), { driverId: BIA });
    await endedPause(2, ago(MINUTE), { businessId: OTHER_COMPANY });

    const taken = await startAna(3, { client: CONTRACT_5 });

    expect(taken.replayed).toBe(false);
    expect(insideLines()).toEqual([]);
  });

  it("the driver's latest ended pause, whichever day", async () => {
    await endedPause(1, ago(3 * 60 * MINUTE));
    await endedPause(2, ago(2 * MINUTE));

    expect(await codeOf(startAna(3, { client: CONTRACT_5 }))).toBe(
      "409 PAUSE_COOLDOWN",
    );
  });
});

describe("GET /current", () => {
  const current = (driverId = ANA, now = NOW) =>
    new CurrentDriverPauseUseCase(repo).execute({
      businessId: COMPANY,
      driverId,
      now,
    });

  it("says nothing to wait for a driver who never ended a pause", async () => {
    expect((await current()).cooldown).toEqual({
      last_ended_at: null,
      next_pause_allowed_at: null,
      next_pause_in_seconds: 0,
    });
  });

  it("says when the next pause may start, and how many seconds that is from now", async () => {
    await endedPause(1, ago(2 * MINUTE + 500));

    expect((await current()).cooldown).toEqual({
      last_ended_at: ago(2 * MINUTE + 500).toISOString(),
      next_pause_allowed_at: new Date(
        NOW.getTime() + 3 * MINUTE - 500,
      ).toISOString(),
      next_pause_in_seconds: 180,
    });
  });

  it("answers 0 once the wait is over, and still names the last end, from yesterday too", async () => {
    // 21:00 yesterday in São Paulo.
    await endedPause(1, new Date("2026-11-05T00:00:00.000Z"));

    expect((await current()).cooldown).toEqual({
      last_ended_at: "2026-11-05T00:00:00.000Z",
      next_pause_allowed_at: "2026-11-05T00:05:00.000Z",
      next_pause_in_seconds: 0,
    });
  });

  it("reads only this driver's pauses of this company", async () => {
    await endedPause(1, ago(MINUTE), { driverId: BIA });
    await endedPause(2, ago(MINUTE), { businessId: OTHER_COMPANY });

    expect((await current()).cooldown.last_ended_at).toBeNull();
    expect((await current(BIA)).cooldown.next_pause_in_seconds).toBe(240);
  });

  it("is sent by the controller as three fields of the answer", async () => {
    await endedPause(1, ago(MINUTE));

    const useCase = new CurrentDriverPauseUseCase(repo);
    const execute = useCase.execute.bind(useCase);

    container.registerInstance(CurrentDriverPauseUseCase, {
      execute: (request: Parameters<typeof execute>[0]) =>
        execute({ ...request, now: NOW }),
    } as never);

    let body: Record<string, unknown> | undefined;
    const reply = {
      status: () => reply,
      send: (payload: Record<string, unknown>) => {
        body = payload;
        return reply;
      },
    };

    try {
      await new CurrentDriverPauseController().handle(
        {
          user: { driverId: ANA },
          params: { businessId: COMPANY },
          headers: {},
        } as never,
        reply as never,
      );
    } finally {
      container.clearInstances();
    }

    expect(body).toMatchObject({
      last_ended_at: ago(MINUTE).toISOString(),
      next_pause_allowed_at: new Date(NOW.getTime() + 4 * MINUTE).toISOString(),
      next_pause_in_seconds: 240,
    });
  });
});

describe("the start controller", () => {
  afterEach(() => {
    container.clearInstances();
  });

  async function post(
    headers: Record<string, string>,
    execute: (request: StartDriverPauseRequest) => Promise<unknown>,
  ) {
    const spy = vi.fn(execute);

    container.registerInstance(StartDriverPauseUseCase, {
      execute: spy,
    } as never);

    const sent: {
      status?: number;
      headers: Record<string, string>;
      body?: unknown;
    } = { headers: {} };
    const reply = {
      header(name: string, value: string) {
        sent.headers[name] = value;
        return reply;
      },
      status(code: number) {
        sent.status = code;
        return reply;
      },
      send(payload: unknown) {
        sent.body = payload;
        return reply;
      },
    };

    await new StartDriverPauseController().handle(
      {
        user: { driverId: ANA },
        params: { businessId: COMPANY },
        headers,
        body: { kind: "MEAL", start_submission_id: key(1), note: null },
      } as never,
      reply as never,
    );

    return { spy, sent };
  }

  const refuse = async () => {
    throw new PauseCooldownError(ago(2 * MINUTE), "America/Sao_Paulo", NOW);
  };

  it("hands the use case the build's contract and whether the queue sent it", async () => {
    const { spy } = await post(
      {
        "x-trajetto-client-version":
          "platform=android; version=1.5.0; build=50; runtime=r; update=embedded; contract=5; outbox=1",
        "x-client-queued-at": "2026-11-05T14:58:00.000Z",
      },
      refuse,
    );

    expect(spy.mock.calls[0][0]).toMatchObject({
      client: { contract: 5 },
      queued: true,
    });
  });

  it("hands null and not-queued when the request says neither", async () => {
    const { spy } = await post({}, refuse);

    expect(spy.mock.calls[0][0]).toMatchObject({
      client: null,
      queued: false,
    });
  });

  it("answers the refusal with 409, its code and the cooldown", async () => {
    const { sent } = await post({}, refuse);

    expect(sent.status).toBe(409);
    expect(sent.headers["x-error-code"]).toBe("PAUSE_COOLDOWN");
    expect(sent.body).toEqual({
      code: "PAUSE_COOLDOWN",
      message:
        "Você encerrou uma pausa às 11:58. Uma nova pausa fica disponível às 12:03.",
      last_ended_at: ago(2 * MINUTE).toISOString(),
      next_pause_allowed_at: new Date(NOW.getTime() + 3 * MINUTE).toISOString(),
      next_pause_in_seconds: 180,
    });
  });

  it("leaves every other refusal to the global handler", async () => {
    await expect(
      post({}, async () => {
        throw new AppError("x", 409, "PAUSE_ALREADY_OPEN");
      }),
    ).rejects.toMatchObject({ code: "PAUSE_ALREADY_OPEN" });
  });
});
