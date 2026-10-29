import { describe, expect, it } from "vitest";

import { routeCompletedAt } from "@/shared/route/route-rules";

/**
 * When a route that closed itself finished (MOB-08).
 *
 * A route closes when its last open stop resolves, and that stop can resolve
 * through a proof or an occurrence the app queued in a dead zone and sent
 * hours later. The stop already carries the time of the fact; the route used
 * to carry the time of the upload, so a route worked until 10:05 read
 * "concluída às 13:40" on the panel, in the tower and in its punctuality.
 */
const NOW = new Date("2026-09-24T13:40:00.000Z");

const at = (hhmm: string) => new Date(`2026-09-24T${hhmm}:00.000Z`);

describe("a route closed by a fact sent late", () => {
  it("finishes at the moment of the fact, not of the upload", () => {
    expect(
      routeCompletedAt({
        closingAt: at("10:05"),
        startedAt: at("07:00"),
        lastResolvedAt: at("10:05"),
        now: NOW,
      }),
    ).toEqual(at("10:05"));
  });

  it("never finishes before a stop that resolved later", () => {
    // The offline proof was the LAST to arrive, not the last to happen: the
    // stop proven online at 12:00 is when the work actually ended.
    expect(
      routeCompletedAt({
        closingAt: at("10:05"),
        startedAt: at("07:00"),
        lastResolvedAt: at("12:00"),
        now: NOW,
      }),
    ).toEqual(at("12:00"));
  });

  it("never finishes before it started", () => {
    expect(
      routeCompletedAt({
        closingAt: at("06:30"),
        startedAt: at("07:00"),
        lastResolvedAt: at("06:30"),
        now: NOW,
      }),
    ).toEqual(at("07:00"));
  });

  it("never finishes in the future", () => {
    expect(
      routeCompletedAt({
        closingAt: new Date(NOW.getTime() + 60_000),
        startedAt: at("07:00"),
        lastResolvedAt: new Date(NOW.getTime() + 60_000),
        now: NOW,
      }),
    ).toEqual(NOW);
  });
});

describe("a route closed with no time of its own", () => {
  it("finishes now, as every close did before", () => {
    // A cancellation from the panel, a load sent back to base: nothing in
    // the field to date it by.
    expect(
      routeCompletedAt({
        closingAt: null,
        startedAt: at("07:00"),
        lastResolvedAt: at("12:00"),
        now: NOW,
      }),
    ).toEqual(NOW);

    expect(routeCompletedAt({ now: NOW })).toEqual(NOW);
  });

  it("does not need the other stops or the start to date a fact", () => {
    expect(routeCompletedAt({ closingAt: at("10:05"), now: NOW })).toEqual(
      at("10:05"),
    );
  });
});
