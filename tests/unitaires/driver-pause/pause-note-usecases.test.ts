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
import { PauseNoteRequiredError } from "@/modules/driver-pause/usecases/errors/driver-pause-errors";
import { startPauseBody } from "@/modules/driver-pause/schemas/driver-pause-schemas";

import { AppError } from "@/shared/errors/AppError";
import type { ClientVersion } from "@/shared/http/client-version";

import { clearLogged, logged } from "../../support/log-capture";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

/**
 * The generic pause's reason through the use cases, on the in-memory twin
 * (owner, 09/11/2026). Only a NEW start of the seeded "Outra pausa" (by its
 * id or by the legacy `kind: OTHER`) sent now by a build whose form asks for
 * the reason (contract 7 on, no X-Client-Queued-At) is refused without 3
 * non-space characters, with nothing written. The company's own types, the
 * other natures, the queue's starts and the older builds are recorded as
 * before (the generic one without its reason with a warn line); a resend is
 * answered before the rule; an end — even one that creates the pause closed
 * — never asks; another company's type is not seen.
 */

const COMPANY = "018fe1e7-0000-7000-8000-00000000000a";
const OTHER_COMPANY = "018fe1e7-0000-7000-8000-00000000000b";
const ANA = "018fe1e7-0000-7000-8000-0000000000a1";
const CAIO = "018fe1e7-0000-7000-8000-0000000000c3";

const TYPE = {
  meal: "018fe1e7-0000-7000-8000-0000000001a1",
  rest: "018fe1e7-0000-7000-8000-0000000001a2",
  other: "018fe1e7-0000-7000-8000-0000000001a3",
  bathroom: "018fe1e7-0000-7000-8000-0000000001a4",
  foreignOther: "018fe1e7-0000-7000-8000-0000000001b3",
};

const key = (n: number) =>
  `018fe1e7-0000-7000-8000-${String(n).padStart(12, "0")}`;

const NOW = new Date("2026-11-09T15:00:00.000Z"); // 12:00 in São Paulo
const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const CONTRACT_7: ClientVersion = { platform: "android", contract: 7 };
const CONTRACT_6: ClientVersion = { platform: "android", contract: 6 };

const NO_REASON_LOG =
  "Generic pause started without a reason by a queued resend or a build without the rule: recorded";

const noReasonLines = () =>
  logged("warn").filter((line) => line.msg === NO_REASON_LOG);

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

/** The note as the route hands it over: cleaned by the body's schema. */
const cleaned = (note: string | null) =>
  startPauseBody.parse({
    occurrence_type_id: TYPE.other,
    start_submission_id: key(999),
    note,
  }).note;

const startAna = (n: number, over: Partial<StartDriverPauseRequest> = {}) =>
  start.execute({
    businessId: COMPANY,
    driverId: ANA,
    occurrenceTypeId: TYPE.other,
    startSubmissionId: key(n),
    startedAt: NOW,
    now: NOW,
    ...over,
  });

beforeEach(() => {
  clearLogged();

  repo = new InMemoryDriverPauseRepository(
    [],
    [],
    [
      { id: ANA, businessId: COMPANY, name: "Ana" },
      { id: CAIO, businessId: COMPANY, name: "Caio" },
    ],
    [
      { id: COMPANY, timezone: "America/Sao_Paulo" },
      { id: OTHER_COMPANY, timezone: "America/Manaus" },
    ],
    [
      {
        id: TYPE.meal,
        businessId: COMPANY,
        category: "PAUSE",
        pause_kind: "MEAL",
        system_key: "pause_meal",
        name: "Refeição",
      },
      {
        id: TYPE.rest,
        businessId: COMPANY,
        category: "PAUSE",
        pause_kind: "REST",
        system_key: "pause_rest",
        name: "Descanso",
      },
      {
        // Renamed by the company: still the generic one.
        id: TYPE.other,
        businessId: COMPANY,
        category: "PAUSE",
        pause_kind: "OTHER",
        system_key: "pause_other",
        name: "Parada diversa",
      },
      {
        id: TYPE.bathroom,
        businessId: COMPANY,
        category: "PAUSE",
        pause_kind: "OTHER",
        system_key: null,
        name: "Banheiro",
      },
      {
        id: TYPE.foreignOther,
        businessId: OTHER_COMPANY,
        category: "PAUSE",
        pause_kind: "OTHER",
        system_key: "pause_other",
        name: "Outra pausa",
      },
    ],
  );

  // Ana is on the street (decision 14.4); Caio has no journey.
  repo.routes.push({
    id: "journey-ana",
    businessId: COMPANY,
    driverId: ANA,
    status: "IN_PROGRESS",
    released_at: new Date("2026-11-09T10:00:00.000Z"),
    started_at: new Date("2026-11-09T11:00:00.000Z"),
    completed_at: null,
    updated_at: new Date("2026-11-09T11:00:00.000Z"),
    scheduled_date: "2026-11-09",
  });

  start = new StartDriverPauseUseCase(repo);
  end = new EndDriverPauseUseCase(repo);
});

describe("a new 'Outra pausa' from contract 7, sent now", () => {
  it("is refused without a reason, and nothing is written", async () => {
    const error = await startAna(1, { client: CONTRACT_7 }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PauseNoteRequiredError);
    expect(error).toMatchObject({
      statusCode: 400,
      code: "PAUSE_NOTE_REQUIRED",
    });
    expect(repo.pauses).toEqual([]);
    // Refused, not recorded: the warn line is for the ones that got in.
    expect(noReasonLines()).toEqual([]);
  });

  it("is refused through the legacy kind OTHER too, which lands on the same type", async () => {
    expect(
      await codeOf(
        startAna(1, {
          client: CONTRACT_7,
          occurrenceTypeId: undefined,
          kind: "OTHER",
        }),
      ),
    ).toBe("400 PAUSE_NOTE_REQUIRED");
    expect(repo.pauses).toEqual([]);
  });

  it("counts the characters that are not spaces: '  a  b ' and 'WC' are refused", async () => {
    for (const [n, note] of [
      [1, cleaned("  a  b ")],
      [2, cleaned("WC")],
      [3, cleaned("   ")],
    ] as const) {
      expect(await codeOf(startAna(n, { client: CONTRACT_7, note }))).toBe(
        "400 PAUSE_NOTE_REQUIRED",
      );
    }

    expect(repo.pauses).toEqual([]);
  });

  it("is recorded with a reason, cleaned as the route cleans it", async () => {
    const taken = await startAna(1, {
      client: CONTRACT_7,
      note: cleaned("  Pneu   furado "),
    });

    expect(taken.replayed).toBe(false);
    expect(taken.pause).toMatchObject({
      kind: "OTHER",
      occurrenceTypeId: TYPE.other,
      note: "Pneu furado",
    });
    expect(noReasonLines()).toEqual([]);
  });
});

describe("what the reason never refuses", () => {
  it("a company type of the OTHER nature, and the meal and the rest", async () => {
    const bathroom = await startAna(1, {
      client: CONTRACT_7,
      occurrenceTypeId: TYPE.bathroom,
    });

    expect(bathroom.pause).toMatchObject({ note: null, kind: "OTHER" });

    await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: NOW,
      now: NOW,
    });

    // Past the cooldown: each start below is judged by the reason alone.
    const later = (minutes: number) =>
      new Date(NOW.getTime() + minutes * MINUTE);

    for (const [n, over] of [
      [2, { occurrenceTypeId: TYPE.meal }],
      [3, { occurrenceTypeId: undefined, kind: "REST" }],
    ] as const) {
      const at = later(10 * n);
      const taken = await startAna(n, {
        client: CONTRACT_7,
        startedAt: at,
        now: at,
        ...over,
      });

      expect(taken.pause.note).toBeNull();

      await end.execute({
        businessId: COMPANY,
        driverId: ANA,
        startSubmissionId: key(n),
        endSubmissionId: key(100 + n),
        endedAt: later(10 * n + 1),
        now: later(10 * n + 1),
      });
    }

    expect(repo.pauses).toHaveLength(3);
    // Only the generic type is missing a reason: none of these is.
    expect(noReasonLines()).toEqual([]);
  });

  it("a build whose form never asked (contract 6, no header) and the offline queue, each with a warn line", async () => {
    const recorded: string[] = [];

    for (const [n, over] of [
      [1, { client: CONTRACT_6 }],
      [2, { client: null }],
      [3, { client: CONTRACT_7, queued: true }],
    ] as const) {
      const at = new Date(NOW.getTime() + n * 10 * MINUTE);
      const taken = await startAna(n, { startedAt: at, now: at, ...over });

      expect(taken.pause).toMatchObject({
        occurrenceTypeId: TYPE.other,
        note: null,
      });
      recorded.push(taken.pause.id);

      await end.execute({
        businessId: COMPANY,
        driverId: ANA,
        startSubmissionId: key(n),
        endSubmissionId: key(100 + n),
        endedAt: new Date(at.getTime() + MINUTE),
        now: new Date(at.getTime() + MINUTE),
      });
    }

    expect(repo.pauses).toHaveLength(3);
    // The trace that tells when the older builds and the queue stop sending
    // the generic pause without its reason: ids and the build, no note.
    expect(noReasonLines()).toEqual([
      expect.objectContaining({
        component: "driver-pause",
        pauseId: recorded[0],
        businessId: COMPANY,
        driverId: ANA,
        clientContract: 6,
        queued: false,
      }),
      expect.objectContaining({
        pauseId: recorded[1],
        clientContract: null,
        queued: false,
      }),
      expect.objectContaining({
        pauseId: recorded[2],
        clientContract: 7,
        queued: true,
      }),
    ]);
  });

  it("a resend of a start that got in, sent now from contract 7, answered before the rule", async () => {
    const queued = await startAna(1, { client: CONTRACT_7, queued: true });
    const resent = await startAna(1, { client: CONTRACT_7 });

    expect(resent).toMatchObject({
      replayed: true,
      pause: { id: queued.pause.id },
    });
    // Said once, when the queue's start got in; never again for the resend.
    expect(noReasonLines()).toEqual([
      expect.objectContaining({ pauseId: queued.pause.id }),
    ]);
  });

  it("an end that arrives before its start and creates the pause closed, from contract 7", async () => {
    const created = await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: NOW,
      start: { occurrenceTypeId: TYPE.other, startedAt: ago(10 * MINUTE) },
      now: NOW,
    });

    expect(created.replayed).toBe(false);
    expect(created.pause).toMatchObject({
      occurrenceTypeId: TYPE.other,
      note: null,
    });

    // The late start, sent at the tap from contract 7, finds it.
    const late = await startAna(1, {
      client: CONTRACT_7,
      startedAt: ago(10 * MINUTE),
    });

    expect(late).toMatchObject({
      replayed: true,
      pause: { id: created.pause.id },
    });
    // The end never asks, so it leaves no trace of a missing reason either.
    expect(noReasonLines()).toEqual([]);
  });
});

describe("the order of the start's refusals", () => {
  it("lets PAUSE_TOO_OLD, another company's type and PAUSE_REQUIRES_ROUTE win over the reason", async () => {
    expect(
      await codeOf(
        startAna(1, { client: CONTRACT_7, startedAt: null, staleTap: true }),
      ),
    ).toBe("409 PAUSE_TOO_OLD");

    // Isolation: another company's generic type is not this company's.
    expect(
      await codeOf(
        startAna(2, {
          client: CONTRACT_7,
          occurrenceTypeId: TYPE.foreignOther,
        }),
      ),
    ).toBe("404 OCCURRENCE_TYPE_NOT_FOUND");

    expect(
      await codeOf(startAna(3, { client: CONTRACT_7, driverId: CAIO })),
    ).toBe("409 PAUSE_REQUIRES_ROUTE");

    expect(repo.pauses).toEqual([]);
  });

  it("refuses for the reason before the cooldown", async () => {
    await startAna(1, {
      client: CONTRACT_7,
      occurrenceTypeId: TYPE.meal,
      startedAt: ago(20 * MINUTE),
    });
    await end.execute({
      businessId: COMPANY,
      driverId: ANA,
      startSubmissionId: key(1),
      endSubmissionId: key(101),
      endedAt: ago(MINUTE),
      now: NOW,
    });

    expect(await codeOf(startAna(2, { client: CONTRACT_7 }))).toBe(
      "400 PAUSE_NOTE_REQUIRED",
    );
    expect(
      await codeOf(startAna(3, { client: CONTRACT_7, note: "Pneu furado" })),
    ).toBe("409 PAUSE_COOLDOWN");
  });
});

describe("the start controller", () => {
  afterEach(() => {
    container.clearInstances();
  });

  it("hands the use case the build's contract and leaves the refusal to the global handler", async () => {
    const seen: StartDriverPauseRequest[] = [];

    container.registerInstance(StartDriverPauseUseCase, {
      execute: async (request: StartDriverPauseRequest) => {
        seen.push(request);
        throw new PauseNoteRequiredError();
      },
    } as never);

    const reply = {
      header: () => reply,
      status: () => reply,
      send: () => reply,
    };

    const error = await new StartDriverPauseController()
      .handle(
        {
          user: { driverId: ANA },
          params: { businessId: COMPANY },
          headers: {
            "x-trajetto-client-version":
              "platform=android; version=1.7.0; build=70; runtime=r; update=embedded; contract=7; outbox=1",
          },
          body: {
            occurrence_type_id: TYPE.other,
            start_submission_id: key(1),
            note: null,
          },
        } as never,
        reply as never,
      )
      .catch((thrown: unknown) => thrown);

    expect(seen[0]).toMatchObject({
      client: { contract: 7 },
      queued: false,
      note: null,
    });
    // Not the cooldown's own answer: an AppError the handler sends with
    // code and message (and x-error-code).
    expect(error).toBeInstanceOf(PauseNoteRequiredError);
  });
});
