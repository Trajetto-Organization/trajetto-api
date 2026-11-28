import { describe, expect, it } from "vitest";

import {
  PAUSE_COOLDOWN_MINUTES,
  PAUSE_COOLDOWN_RULE_CONTRACT,
  PAUSE_COOLDOWN_TOLERANCE_MS,
  enforcesPauseCooldown,
  pauseCooldown,
  pauseCooldownMessage,
  pauseCooldownView,
} from "@/modules/driver-pause/rules/pause-rules";
import { PauseCooldownError } from "@/modules/driver-pause/usecases/errors/driver-pause-errors";
import { AppError } from "@/shared/errors/AppError";

/**
 * The 5 minutes between pauses (owner, 05/11/2026): only the START of a new
 * pause waits, and only that long after the previous one ended — Lei
 * 13.103/2015 lets the driving rest be split, so the wait only stops the
 * on/off spam. The server refuses a tap less than 5 min − 30 s after the end
 * (the slack absorbs the phone's clock correction); what it shows has no
 * slack, and the seconds left are counted from the server's now so the app
 * counts down on its own clock.
 */
const ENDED = new Date("2026-11-05T13:00:00.000Z"); // 10:00 in São Paulo
const after = (ms: number) => new Date(ENDED.getTime() + ms);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

describe("the cooldown's numbers", () => {
  it("is 5 minutes, with 30 seconds of slack, from contract 5", () => {
    expect(PAUSE_COOLDOWN_MINUTES).toBe(5);
    expect(PAUSE_COOLDOWN_TOLERANCE_MS).toBe(30 * SECOND);
    expect(PAUSE_COOLDOWN_RULE_CONTRACT).toBe(5);
  });
});

describe("pauseCooldown", () => {
  const blocks = (gap: number) =>
    pauseCooldown({ lastEndedAt: ENDED, tap: after(gap), now: after(gap) })
      .blocks;

  it("never blocks a driver with no ended pause", () => {
    expect(
      pauseCooldown({ lastEndedAt: null, tap: ENDED, now: ENDED }),
    ).toEqual({
      blocks: false,
      last_ended_at: null,
      next_pause_allowed_at: null,
      next_pause_in_seconds: 0,
    });
  });

  it("blocks up to 4:29.999 after the end and lets 4:30 through", () => {
    expect(blocks(0)).toBe(true);
    expect(blocks(1 * MINUTE)).toBe(true);
    expect(blocks(4 * MINUTE + 29 * SECOND + 999)).toBe(true);
    expect(blocks(4 * MINUTE + 30 * SECOND)).toBe(false);
    expect(blocks(5 * MINUTE)).toBe(false);
    expect(blocks(3 * 60 * MINUTE)).toBe(false);
  });

  it("counts a tap before the end (a negative gap) as inside the cooldown", () => {
    expect(blocks(-1)).toBe(true);
    expect(blocks(-10 * MINUTE)).toBe(true);
  });

  it("measures the refusal from the tap, and the seconds left from now", () => {
    // Tapped inside, received after the cooldown: still refused, and the
    // answer says it is available now.
    expect(
      pauseCooldown({
        lastEndedAt: ENDED,
        tap: after(2 * MINUTE),
        now: after(6 * MINUTE),
      }),
    ).toEqual({
      blocks: true,
      last_ended_at: ENDED.toISOString(),
      next_pause_allowed_at: after(5 * MINUTE).toISOString(),
      next_pause_in_seconds: 0,
    });

    // Tapped after it, read by a late clock: accepted all the same.
    expect(
      pauseCooldown({
        lastEndedAt: ENDED,
        tap: after(5 * MINUTE),
        now: after(MINUTE),
      }).blocks,
    ).toBe(false);
  });

  it("never blocks on a date it cannot read", () => {
    expect(
      pauseCooldown({
        lastEndedAt: new Date(Number.NaN),
        tap: ENDED,
        now: ENDED,
      }).blocks,
    ).toBe(false);
    expect(
      pauseCooldown({
        lastEndedAt: ENDED,
        tap: new Date(Number.NaN),
        now: ENDED,
      }).blocks,
    ).toBe(false);
  });
});

describe("pauseCooldownView", () => {
  const view = (now: Date) => pauseCooldownView(ENDED, now);

  it("shows the end and the end plus 5 minutes, with no slack", () => {
    expect(view(after(MINUTE))).toEqual({
      last_ended_at: "2026-11-05T13:00:00.000Z",
      next_pause_allowed_at: "2026-11-05T13:05:00.000Z",
      next_pause_in_seconds: 240,
    });
  });

  it("rounds the seconds left up and stops at zero", () => {
    expect(view(ENDED).next_pause_in_seconds).toBe(300);
    expect(view(after(500)).next_pause_in_seconds).toBe(300);
    expect(
      view(after(4 * MINUTE + 59 * SECOND + 1)).next_pause_in_seconds,
    ).toBe(1);
    expect(view(after(5 * MINUTE)).next_pause_in_seconds).toBe(0);
    expect(view(after(60 * MINUTE)).next_pause_in_seconds).toBe(0);
    // A pause that ended "after now" (a clock ahead) never goes past 300 + its lead.
    expect(view(after(-2 * SECOND)).next_pause_in_seconds).toBe(302);
  });

  it("is empty with no ended pause", () => {
    expect(pauseCooldownView(null, ENDED)).toEqual({
      last_ended_at: null,
      next_pause_allowed_at: null,
      next_pause_in_seconds: 0,
    });
  });
});

describe("enforcesPauseCooldown", () => {
  it("refuses only a direct send from contract 5 on", () => {
    expect(enforcesPauseCooldown({ clientContract: 5, queued: false })).toBe(
      true,
    );
    expect(enforcesPauseCooldown({ clientContract: 6, queued: false })).toBe(
      true,
    );
  });

  it("records what the offline queue sends, and every build that does not hold the wait", () => {
    expect(enforcesPauseCooldown({ clientContract: 5, queued: true })).toBe(
      false,
    );
    expect(enforcesPauseCooldown({ clientContract: 4, queued: false })).toBe(
      false,
    );
    expect(
      enforcesPauseCooldown({ clientContract: undefined, queued: false }),
    ).toBe(false);
    expect(enforcesPauseCooldown({ clientContract: null, queued: false })).toBe(
      false,
    );
  });
});

describe("pauseCooldownMessage", () => {
  it("says both times in the company's zone, 5 minutes apart", () => {
    expect(pauseCooldownMessage(ENDED, "America/Sao_Paulo")).toBe(
      "Você encerrou uma pausa às 10:00. Uma nova pausa fica disponível às 10:05.",
    );
    expect(pauseCooldownMessage(ENDED, "America/Manaus")).toBe(
      "Você encerrou uma pausa às 09:00. Uma nova pausa fica disponível às 09:05.",
    );
  });

  it("crosses midnight", () => {
    expect(
      pauseCooldownMessage(
        new Date("2026-11-06T02:57:10.000Z"),
        "America/Sao_Paulo",
      ),
    ).toBe(
      "Você encerrou uma pausa às 23:57. Uma nova pausa fica disponível às 00:03.",
    );
  });

  it("truncates the end like every screen and rounds the next start up, so a start tapped at the minute shown is accepted", () => {
    expect(pauseCooldownMessage(after(29 * SECOND), "America/Sao_Paulo")).toBe(
      "Você encerrou uma pausa às 10:00. Uma nova pausa fica disponível às 10:06.",
    );
    expect(pauseCooldownMessage(after(59 * SECOND), "America/Sao_Paulo")).toBe(
      "Você encerrou uma pausa às 10:00. Uma nova pausa fica disponível às 10:06.",
    );

    // Every second of the minute: the instant of the minute shown passes,
    // even without the tolerance.
    for (let second = 0; second < 60; second++) {
      const ended = after(second * SECOND + 999);
      const shown = /disponível às 10:(\d{2})/.exec(
        pauseCooldownMessage(ended, "America/Sao_Paulo"),
      );
      const tap = new Date(`2026-11-05T13:${shown![1]}:00.000Z`);

      expect(
        pauseCooldown({ lastEndedAt: ended, tap, now: tap }).blocks,
        `ended at 10:00:${second}`,
      ).toBe(false);
      expect(
        tap.getTime() - ended.getTime(),
        `ended at 10:00:${second}`,
      ).toBeGreaterThanOrEqual(5 * MINUTE);
    }
  });

  it("falls back to the default zone for one it cannot read", () => {
    expect(pauseCooldownMessage(ENDED, "Not/AZone")).toContain("às 10:00");
  });
});

describe("PauseCooldownError", () => {
  it("is a 409 PAUSE_COOLDOWN with the cooldown from the server's now", () => {
    const error = new PauseCooldownError(
      ENDED,
      "America/Sao_Paulo",
      after(2 * MINUTE),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 409,
      code: "PAUSE_COOLDOWN",
      message:
        "Você encerrou uma pausa às 10:00. Uma nova pausa fica disponível às 10:05.",
      cooldown: {
        last_ended_at: ENDED.toISOString(),
        next_pause_allowed_at: after(5 * MINUTE).toISOString(),
        next_pause_in_seconds: 180,
      },
    });
  });

  it("builds from any value, as the error-class sweep instantiates it", () => {
    const Loose = PauseCooldownError as unknown as new (
      ...args: unknown[]
    ) => PauseCooldownError;

    expect(() => new Loose(1, 1)).not.toThrow();
  });
});
