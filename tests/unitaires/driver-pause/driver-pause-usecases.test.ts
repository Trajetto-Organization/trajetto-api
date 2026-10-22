import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryDriverPauseRepository } from "@/modules/driver-pause/repositories/in-memory/in-memory-driver-pause-repository";

import { StartDriverPauseUseCase } from "@/modules/driver-pause/usecases/start-driver-pause/start-driver-pause-usecase";
import { EndDriverPauseUseCase } from "@/modules/driver-pause/usecases/end-driver-pause/end-driver-pause-usecase";
import { CurrentDriverPauseUseCase } from "@/modules/driver-pause/usecases/current-driver-pause/current-driver-pause-usecase";
import { DriverPauseReportUseCase } from "@/modules/driver-pause/usecases/driver-pause-report/driver-pause-report-usecase";

import {
  normalizePauseNote,
  pauseEndedAt,
} from "@/modules/driver-pause/rules/pause-rules";

import { AppError } from "@/shared/errors/AppError";

/**
 * The pause use cases on the in-memory twin: idempotency by the gesture's
 * key, the one-open-pause rule, every order the outbox can deliver in, and
 * the driver-only writes. The twin itself is held to Postgres by
 * tests/E2E/driver-pause-repository-contract.test.ts.
 */

const COMPANY = "018f1000-0000-7000-8000-00000000000a";
const OTHER_COMPANY = "018f1000-0000-7000-8000-00000000000b";
const ANA = "018f1000-0000-7000-8000-0000000000a1";
const BIA = "018f1000-0000-7000-8000-0000000000b2";

const key = (n: number) =>
  `018f1000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const NOW = new Date("2026-09-29T18:00:00.000Z"); // 15:00 in São Paulo
const minutesBefore = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

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

beforeEach(() => {
  repo = new InMemoryDriverPauseRepository(
    [],
    [],
    [
      { id: ANA, businessId: COMPANY, name: "Ana" },
      { id: BIA, businessId: COMPANY, name: "Bia" },
    ],
    [
      { id: COMPANY, timezone: "America/Sao_Paulo" },
      { id: OTHER_COMPANY, timezone: "America/Manaus" },
    ],
  );

  // Decision 14.4: a pause needs a journey. Both drivers are on a route that
  // has been on the street since the start of the month, so the rules below
  // are tested on their own; the journey rule has its own describe.
  for (const driverId of [ANA, BIA]) {
    repo.routes.push({
      id: `journey-${driverId}`,
      businessId: COMPANY,
      driverId,
      status: "IN_PROGRESS",
      released_at: new Date("2026-09-01T10:00:00.000Z"),
      started_at: new Date("2026-09-01T11:00:00.000Z"),
      completed_at: null,
      updated_at: new Date("2026-09-01T11:00:00.000Z"),
      scheduled_date: "2026-09-01",
    });
  }

  start = new StartDriverPauseUseCase(repo);
  end = new EndDriverPauseUseCase(repo);
});

const startAna = (n: number, startedAt: Date | null = minutesBefore(30)) =>
  start.execute({
    businessId: COMPANY,
    driverId: ANA,
    kind: "MEAL",
    startSubmissionId: key(n),
    startedAt,
    now: NOW,
  });

describe("starting a pause", () => {
  it("creates it with the phone's instant and answers a resend with the same pause", async () => {
    const first = await startAna(1);

    expect(first.replayed).toBe(false);
    expect(first.pause.started_at).toEqual(minutesBefore(30));
    expect(first.pause.ended_at).toBeNull();

    const again = await startAna(1, minutesBefore(5));

    expect(again).toMatchObject({ pause: first.pause, replayed: true });
    expect(repo.pauses).toHaveLength(1);
  });

  it("uses the receipt time when the phone sent no readable instant", async () => {
    const { pause } = await startAna(1, null);

    expect(pause.started_at).toEqual(NOW);
  });

  it("refuses a second open pause with another key", async () => {
    await startAna(1);

    expect(await codeOf(startAna(2))).toBe("409 PAUSE_ALREADY_OPEN");
  });

  it("refuses anybody who is not a driver, before touching anything", async () => {
    expect(
      await codeOf(
        start.execute({
          businessId: COMPANY,
          driverId: null,
          kind: "REST",
          startSubmissionId: key(1),
          startedAt: null,
        }),
      ),
    ).toBe("403 PERMISSION_DENIED");

    expect(repo.pauses).toHaveLength(0);
  });

  it("never hands another driver's pause over on a guessed key", async () => {
    await startAna(1);

    expect(
      await codeOf(
        start.execute({
          businessId: COMPANY,
          driverId: BIA,
          kind: "MEAL",
          startSubmissionId: key(1),
          startedAt: null,
          now: NOW,
        }),
      ),
    ).toBe("409 SUBMISSION_OWNER_MISMATCH");
  });

  it("refuses a new start tapped beyond the offline horizon, and keeps the slot free", async () => {
    // Dated by its arrival it opened a pause the driver never began, and the
    // driver's real start was refused with PAUSE_ALREADY_OPEN.
    expect(
      await codeOf(
        start.execute({
          businessId: COMPANY,
          driverId: ANA,
          kind: "OTHER",
          startSubmissionId: key(1),
          startedAt: null,
          staleTap: true,
          now: NOW,
        }),
      ),
    ).toBe("409 PAUSE_TOO_OLD");

    expect(repo.pauses).toHaveLength(0);
    expect((await startAna(2)).replayed).toBe(false);
  });

  it("still answers the resend of a start that got in, whatever its age", async () => {
    const first = await startAna(1);

    const late = await start.execute({
      businessId: COMPANY,
      driverId: ANA,
      kind: "MEAL",
      startSubmissionId: key(1),
      startedAt: null,
      staleTap: true,
      now: NOW,
    });

    expect(late).toMatchObject({ pause: first.pause, replayed: true });
  });

  it("pins the route that was on the street at the tap, not at arrival", async () => {
    repo.routes.push(
      {
        id: "morning",
        businessId: COMPANY,
        driverId: ANA,
        status: "COMPLETED",
        started_at: minutesBefore(300),
        completed_at: minutesBefore(60),
        updated_at: minutesBefore(60),
      },
      {
        id: "afternoon",
        businessId: COMPANY,
        driverId: ANA,
        status: "IN_PROGRESS",
        started_at: minutesBefore(30),
        completed_at: null,
        updated_at: minutesBefore(30),
      },
    );

    // Tapped offline two hours ago, delivered now.
    const { pause } = await startAna(1, minutesBefore(120));

    expect(pause.routeId).toBe("morning");
  });
});

describe("ending a pause", () => {
  it("closes the open pause named by its start key, and answers a resend of the end", async () => {
    await startAna(1);

    const closed = await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: minutesBefore(1),
      now: NOW,
    });

    expect(closed.replayed).toBe(false);
    expect(closed.pause.ended_at).toEqual(minutesBefore(1));
    expect(closed.pause.end_submission_id).toBe(key(101));

    const again = await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: NOW,
      now: NOW,
    });

    expect(again).toMatchObject({ pause: closed.pause, replayed: true });
  });

  it("never ends a pause before it began", async () => {
    await startAna(1, minutesBefore(10));

    const { pause } = await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: minutesBefore(40),
      now: NOW,
    });

    expect(pause.ended_at).toEqual(minutesBefore(10));
  });

  // The type passed the read but was changed before the write (the
  // repository's own check, under the insert): the same 400 the start gives,
  // not a 404 about a pause that was never the problem.
  it("refuses an end that would create the pause when its type stopped being a pause type", async () => {
    repo.createPause = async () => ({ status: "invalid-type" }) as never;

    expect(
      await codeOf(
        end.execute({
          businessId: COMPANY,
          driverId: ANA,
          startSubmissionId: key(7),
          endSubmissionId: key(107),
          endedAt: minutesBefore(5),
          start: { kind: "REST", startedAt: minutesBefore(35) },
          now: NOW,
        }),
      ),
    ).toBe("400 OCCURRENCE_TYPE_WRONG_CATEGORY");
  });

  it("creates the pause already closed when the end arrives before its start, and the late start finds it", async () => {
    const closed = await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: minutesBefore(5),
      start: { kind: "REST", startedAt: minutesBefore(35), note: "Posto" },
      now: NOW,
    });

    expect(closed.pause).toMatchObject({
      kind: "REST",
      note: "Posto",
      started_at: minutesBefore(35),
      ended_at: minutesBefore(5),
    });

    const late = await startAna(1);

    expect(late).toMatchObject({ pause: closed.pause, replayed: true });
    expect(repo.pauses).toHaveLength(1);

    // And the driver is not left "on a pause": a new one may start.
    expect((await startAna(2)).replayed).toBe(false);
  });

  it("refuses to create the pause from an end whose start or end is past the horizon", async () => {
    for (const [endStale, startStale] of [
      [false, true],
      [true, false],
    ]) {
      expect(
        await codeOf(
          end.execute({
            businessId: COMPANY,
            driverId: ANA,
            startSubmissionId: key(1),
            endSubmissionId: key(101),
            endedAt: null,
            staleTap: endStale,
            start: { kind: "REST", startedAt: null, staleTap: startStale },
            now: NOW,
          }),
        ),
      ).toBe("409 PAUSE_TOO_OLD");
    }

    expect(repo.pauses).toHaveLength(0);
  });

  it("closes a pause that exists even with a stale end, at the receipt time", async () => {
    // Refusing it would hold the one open slot forever.
    await startAna(1, minutesBefore(60));

    const { pause } = await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: null,
      staleTap: true,
      start: { kind: "MEAL", startedAt: null, staleTap: true },
      now: NOW,
    });

    expect(pause.ended_at).toEqual(NOW);
    expect((await startAna(2)).replayed).toBe(false);
  });

  it("answers 404 for an end with no start anywhere", async () => {
    expect(
      await codeOf(
        end.execute({
          businessId: COMPANY,
          driverId: ANA,
          startSubmissionId: key(1),
          endSubmissionId: key(101),
          endedAt: null,
          now: NOW,
        }),
      ),
    ).toBe("404 PAUSE_NOT_FOUND");
  });

  it("refuses a second end with another key, and an end key reused on another pause", async () => {
    await startAna(1);
    await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: null,
      now: NOW,
    });

    expect(
      await codeOf(
        end.execute({
          businessId: COMPANY,
          driverId: ANA,
          startSubmissionId: key(1),
          endSubmissionId: key(102),
          endedAt: null,
          now: NOW,
        }),
      ),
    ).toBe("409 PAUSE_ALREADY_ENDED");

    await startAna(2);

    expect(
      await codeOf(
        end.execute({
          businessId: COMPANY,
          driverId: ANA,
          startSubmissionId: key(2),
          endSubmissionId: key(101),
          endedAt: null,
          now: NOW,
        }),
      ),
    ).toBe("409 PAUSE_SUBMISSION_REUSED");
  });

  it("refuses to close another driver's pause", async () => {
    await startAna(1);

    expect(
      await codeOf(
        end.execute({
          businessId: COMPANY,
          driverId: BIA,
          startSubmissionId: key(1),
          endSubmissionId: key(101),
          endedAt: null,
          now: NOW,
        }),
      ),
    ).toBe("409 SUBMISSION_OWNER_MISMATCH");
  });

  it("does not see a key of another company", async () => {
    await startAna(1);

    expect(
      await codeOf(
        end.execute({
          businessId: OTHER_COMPANY,
          driverId: ANA,
          startSubmissionId: key(1),
          endSubmissionId: key(101),
          endedAt: null,
          now: NOW,
        }),
      ),
    ).toBe("404 PAUSE_NOT_FOUND");
  });
});

describe("the driver's current pause", () => {
  it("returns the open pause and today's pauses in the company's day", async () => {
    // Yesterday 23:50 in São Paulo: not today, but still the open one if open.
    await startAna(1, new Date("2026-09-29T02:50:00.000Z"));
    await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: new Date("2026-09-29T03:20:00.000Z"),
      now: NOW,
    });
    await startAna(2, minutesBefore(20));

    const current = await new CurrentDriverPauseUseCase(repo).execute({
      businessId: COMPANY,
      driverId: ANA,
      now: NOW,
    });

    expect(current.day).toBe("2026-09-29");
    expect(current.timeZone).toBe("America/Sao_Paulo");
    expect(current.open?.start_submission_id).toBe(key(2));
    expect(current.today.map((pause) => pause.start_submission_id)).toEqual([
      key(2),
    ]);
  });

  it("refuses a user who is not a driver", async () => {
    expect(
      await codeOf(
        new CurrentDriverPauseUseCase(repo).execute({
          businessId: COMPANY,
          driverId: null,
        }),
      ),
    ).toBe("403 PERMISSION_DENIED");
  });
});

describe("the office report", () => {
  it("pages the driver-days and refuses a range longer than 31 days", async () => {
    for (const [index, driverId] of [ANA, BIA].entries()) {
      repo.routes.push({
        id: `route-${index}`,
        businessId: COMPANY,
        driverId,
        status: "COMPLETED",
        started_at: minutesBefore(600),
        completed_at: minutesBefore(300),
        updated_at: minutesBefore(300),
      });
    }

    const useCase = new DriverPauseReportUseCase(repo);

    const first = await useCase.execute({
      businessId: COMPANY,
      page: 1,
      pageSize: 1,
      now: NOW,
    });

    expect(first.total).toBe(2);
    expect(first.data.map((row) => row.driverName)).toEqual(["Ana"]);
    expect(first.from).toBe("2026-09-23");
    expect(first.to).toBe("2026-09-29");

    const second = await useCase.execute({
      businessId: COMPANY,
      page: 2,
      pageSize: 1,
      now: NOW,
    });

    expect(second.data.map((row) => row.driverName)).toEqual(["Bia"]);

    expect(
      await codeOf(
        useCase.execute({
          businessId: COMPANY,
          from: "2026-08-01",
          to: "2026-09-29",
          page: 1,
          pageSize: 10,
          now: NOW,
        }),
      ),
    ).toBe("400 PAUSE_REPORT_RANGE_INVALID");
  });

  it("answers a day the date helpers cannot move with a 400, not a crash", async () => {
    const useCase = new DriverPauseReportUseCase(repo);

    for (const range of [
      { to: "9999-12-31" },
      { from: "0001-01-01", to: "0001-01-02" },
    ]) {
      expect(
        await codeOf(
          useCase.execute({
            businessId: COMPANY,
            ...range,
            page: 1,
            pageSize: 10,
            now: NOW,
          }),
        ),
        JSON.stringify(range),
      ).toBe("400 PAUSE_REPORT_RANGE_INVALID");
    }
  });

  it("answers 404 for a company that does not exist", async () => {
    expect(
      await codeOf(
        new DriverPauseReportUseCase(repo).execute({
          businessId: "018f1000-0000-7000-8000-0000000000ee",
          page: 1,
          pageSize: 10,
        }),
      ),
    ).toBe("404 TENANT_NOT_FOUND");
  });
});

describe("pause rules", () => {
  it("cleans the note instead of refusing it", () => {
    expect(normalizePauseNote("  Almoço   no\n posto  ")).toBe(
      "Almoço no posto",
    );
    expect(normalizePauseNote("   ")).toBeNull();
    expect(normalizePauseNote(undefined)).toBeNull();
  });

  it("ends at the receipt time without an instant, and never before the start", () => {
    const began = minutesBefore(10);

    expect(pauseEndedAt(began, null, NOW)).toEqual(NOW);
    expect(pauseEndedAt(began, minutesBefore(20), NOW)).toEqual(began);
  });
});

describe("pauses as PAUSE occurrence types inside a journey (decision 14.4)", () => {
  const CAIO = "018f1000-0000-7000-8000-0000000000c3";

  const pauseType = (
    overrides: Partial<(typeof repo.occurrenceTypes)[number]> = {},
  ) => {
    const type = {
      id: `018f1000-0000-7000-8000-0000000${String(repo.occurrenceTypes.length + 1).padStart(5, "0")}`,
      businessId: COMPANY,
      category: "PAUSE" as const,
      pause_kind: "REST" as const,
      system_key: null,
      name: "Lanche",
      is_active: true,
      ...overrides,
    };

    repo.occurrenceTypes.push(type);

    return type;
  };

  it("refuses a start with no route released or running, writing nothing", async () => {
    expect(
      await codeOf(
        start.execute({
          businessId: COMPANY,
          driverId: CAIO,
          kind: "MEAL",
          startSubmissionId: key(1),
          startedAt: minutesBefore(5),
          now: NOW,
        }),
      ),
    ).toBe("409 PAUSE_REQUIRES_ROUTE");
    expect(repo.pauses).toHaveLength(0);
  });

  it("starts on a route released today but not yet started, and pins it", async () => {
    repo.routes.push({
      id: "released-today",
      businessId: COMPANY,
      driverId: CAIO,
      status: "RELEASED",
      released_at: minutesBefore(120),
      started_at: null,
      completed_at: null,
      updated_at: minutesBefore(120),
      scheduled_date: "2026-09-29",
    });

    const { pause } = await start.execute({
      businessId: COMPANY,
      driverId: CAIO,
      kind: "REST",
      startSubmissionId: key(1),
      startedAt: minutesBefore(5),
      now: NOW,
    });

    expect(pause.routeId).toBe("released-today");
  });

  it("refuses a route released today for tomorrow", async () => {
    repo.routes.push({
      id: "tomorrow",
      businessId: COMPANY,
      driverId: CAIO,
      status: "RELEASED",
      released_at: minutesBefore(120),
      started_at: null,
      completed_at: null,
      updated_at: minutesBefore(120),
      scheduled_date: "2026-09-30",
    });

    expect(
      await codeOf(
        start.execute({
          businessId: COMPANY,
          driverId: CAIO,
          kind: "REST",
          startSubmissionId: key(1),
          startedAt: minutesBefore(5),
          now: NOW,
        }),
      ),
    ).toBe("409 PAUSE_REQUIRES_ROUTE");
  });

  it("refuses an end that would create the pause outside a journey, but always closes one that exists", async () => {
    expect(
      await codeOf(
        end.execute({
          businessId: COMPANY,
          driverId: CAIO,
          startSubmissionId: key(1),
          endSubmissionId: key(101),
          endedAt: minutesBefore(1),
          start: { kind: "MEAL", startedAt: minutesBefore(40) },
          now: NOW,
        }),
      ),
    ).toBe("409 PAUSE_REQUIRES_ROUTE");
    expect(repo.pauses).toHaveLength(0);

    // Ana's pause starts inside her journey; the route then leaves the
    // street (cancelled) before she ends it.
    await startAna(2, minutesBefore(30));
    repo.routes = repo.routes.filter((entry) => entry.driverId !== ANA);

    const { pause } = await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(2),
      endSubmissionId: key(102),
      endedAt: minutesBefore(1),
      now: NOW,
    });

    expect(pause.ended_at).toEqual(minutesBefore(1));
  });

  it("answers the resend of a start that got in even after the journey ended", async () => {
    const first = await startAna(1, minutesBefore(30));
    repo.routes = repo.routes.filter((entry) => entry.driverId !== ANA);

    const again = await startAna(1, minutesBefore(30));

    expect(again).toMatchObject({ pause: first.pause, replayed: true });
  });

  it("records the installed app's `kind` under the company's default type of that nature", async () => {
    const { pause, typeNames } = await startAna(1);

    const meal = repo.occurrenceTypes.find(
      (type) => type.businessId === COMPANY && type.system_key === "pause_meal",
    );

    expect(meal).toBeDefined();
    expect(pause.occurrenceTypeId).toBe(meal!.id);
    expect(pause.kind).toBe("MEAL");
    expect(typeNames.get(meal!.id)).toBe("Refeição");
  });

  it("records the chosen type with ITS nature, whatever `kind` the body carried", async () => {
    const snack = pauseType({ name: "Lanche", pause_kind: "REST" });

    const { pause } = await start.execute({
      businessId: COMPANY,
      driverId: ANA,
      kind: "MEAL",
      occurrenceTypeId: snack.id,
      startSubmissionId: key(1),
      startedAt: minutesBefore(5),
      now: NOW,
    });

    expect(pause.occurrenceTypeId).toBe(snack.id);
    expect(pause.kind).toBe("REST");
  });

  it("accepts a deactivated pause type: the pause happened", async () => {
    const old = pauseType({
      name: "Café",
      pause_kind: "OTHER",
      is_active: false,
    });

    const { pause } = await start.execute({
      businessId: COMPANY,
      driverId: ANA,
      occurrenceTypeId: old.id,
      startSubmissionId: key(1),
      startedAt: minutesBefore(5),
      now: NOW,
    });

    expect(pause.occurrenceTypeId).toBe(old.id);
  });

  it("answers another company's type like a missing one, and refuses a type that is not a pause", async () => {
    const foreign = pauseType({ businessId: OTHER_COMPANY });
    const delivered = pauseType({
      category: "DELIVERED",
      pause_kind: null,
      name: "Entrega",
    });

    const startWith = (occurrenceTypeId: string, n: number) =>
      start.execute({
        businessId: COMPANY,
        driverId: ANA,
        occurrenceTypeId,
        startSubmissionId: key(n),
        startedAt: minutesBefore(5),
        now: NOW,
      });

    expect(await codeOf(startWith(foreign.id, 1))).toBe(
      "404 OCCURRENCE_TYPE_NOT_FOUND",
    );
    expect(await codeOf(startWith(delivered.id, 2))).toBe(
      "400 OCCURRENCE_TYPE_WRONG_CATEGORY",
    );
    expect(repo.pauses).toHaveLength(0);
  });

  it("tells the app whether a pause may start now, and names the types", async () => {
    const current = new CurrentDriverPauseUseCase(repo);

    await startAna(1, minutesBefore(10));

    const ana = await current.execute({
      businessId: COMPANY,
      driverId: ANA,
      now: NOW,
    });
    const caio = await current.execute({
      businessId: COMPANY,
      driverId: CAIO,
      now: NOW,
    });

    expect(ana.pauseAllowed).toBe(true);
    expect(ana.journeyRouteId).toBe(`journey-${ANA}`);
    expect(ana.typeNames.get(ana.open!.occurrenceTypeId)).toBe("Refeição");
    expect(caio.pauseAllowed).toBe(false);
    expect(caio.journeyRouteId).toBeNull();
  });
});
