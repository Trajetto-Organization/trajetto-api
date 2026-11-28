import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HISTORY_WINDOW_SETTING,
  historyWindowApproval,
} from "infra/scripts/release-step-runner";

/**
 * HISTORY_WINDOW_APPROVED, the owner's approval of the history's copy
 * window (plano-escala F2-17, D39, D68).
 *
 * The copy runs only inside the interval typed in the Environment of
 * trajetto-api-migrate, so a hotfix promoted after the release never runs
 * it by surprise. An approval is therefore read strictly: two ISO instants
 * with their zone, the start before the end, at most a day apart; anything
 * else approves nothing, with the reason for the log. The release step
 * hands the normalized interval to every file as one session setting,
 * which the window steps read.
 */
describe("historyWindowApproval", () => {
  it("is absent without the variable, or with it empty", () => {
    expect(historyWindowApproval({})).toEqual({ state: "absent" });
    expect(historyWindowApproval({ HISTORY_WINDOW_APPROVED: "  " })).toEqual({
      state: "absent",
    });
  });

  it("approves an interval of instants with their zone, normalized to UTC", () => {
    const approval = historyWindowApproval({
      HISTORY_WINDOW_APPROVED: "2026-12-06T03:00:00-03:00/2026-12-06T07:30:00Z",
    });

    expect(approval).toEqual({
      state: "approved",
      from: new Date("2026-12-06T06:00:00Z"),
      to: new Date("2026-12-06T07:30:00Z"),
      setting: "2026-12-06T06:00:00.000Z/2026-12-06T07:30:00.000Z",
    });
  });

  it.each([
    ["one instant", "2026-12-06T06:00:00Z"],
    ["three parts", "2026-12-06T06:00:00Z/2026-12-06T07:00:00Z/x"],
    ["no zone", "2026-12-06T06:00:00/2026-12-06T07:30:00"],
    ["a date alone", "2026-12-06/2026-12-07"],
    ["words", "domingo/segunda"],
    ["the end first", "2026-12-06T07:30:00Z/2026-12-06T06:00:00Z"],
    ["an empty interval", "2026-12-06T06:00:00Z/2026-12-06T06:00:00Z"],
    ["more than a day", "2026-12-06T06:00:00Z/2026-12-07T06:00:01Z"],
  ])("approves nothing with %s", (_case, value) => {
    const approval = historyWindowApproval({ HISTORY_WINDOW_APPROVED: value });

    expect(approval.state).toBe("invalid");
    expect(approval).toHaveProperty("reason");
  });

  it("accepts a whole day exactly", () => {
    expect(
      historyWindowApproval({
        HISTORY_WINDOW_APPROVED: "2026-12-06T06:00:00Z/2026-12-07T06:00:00Z",
      }).state,
    ).toBe("approved");
  });

  it("is the setting the window steps read", () => {
    const step = readFileSync(
      resolve(process.cwd(), "prisma/post-deploy/30-delivery-event-window.sql"),
      "utf8",
    );

    expect(HISTORY_WINDOW_SETTING).toBe("trajetto.history_window_approved");
    expect(step).toContain(
      `current_setting('${HISTORY_WINDOW_SETTING}', true)`,
    );
  });

  it("is handed to the runner by the release step", () => {
    const main = readFileSync(
      resolve(process.cwd(), "infra/scripts/release-steps.ts"),
      "utf8",
    );

    expect(main).toContain("historyWindowApproval(process.env)");
    expect(main).toContain("[HISTORY_WINDOW_SETTING]: approval.setting");
  });
});
