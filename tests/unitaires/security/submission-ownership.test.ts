import { describe, expect, it } from "vitest";

import { submissionBelongsToCaller } from "@/shared/security/submission-ownership";

/**
 * Who may be handed the record behind an idempotency key.
 *
 * The key is unique per `(businessId, client_submission_id)`, so a replay
 * cannot cross carriers. Inside one carrier it could: the early return that
 * answers a retry runs before the driver-ownership check, so a guessed
 * identifier read back another driver's submission — the vehicle, the
 * mileage, the litres, the cost and the key to the photo.
 *
 * The rule has to refuse in exactly one case and allow in the rest. Refusing
 * too widely is not the safe direction here: it would break the dashboard's
 * own retries and every record created from the web.
 */
describe("a driver replaying a key", () => {
  it("gets their own submission back", () => {
    expect(submissionBelongsToCaller("driver-1", "driver-1")).toBe(true);
  });

  it("is refused another driver's submission", () => {
    expect(submissionBelongsToCaller("driver-1", "driver-2")).toBe(false);
  });

  it("may read a record the dashboard created", () => {
    // No driver on the row means it belongs to the company, not to a person.
    expect(submissionBelongsToCaller("driver-1", null)).toBe(true);
    expect(submissionBelongsToCaller("driver-1", undefined)).toBe(true);
  });
});

describe("a caller who is not a driver", () => {
  it("is bounded by the tenant check rather than by this rule", () => {
    // A dispatcher retrying from the dashboard must still get their answer;
    // narrowing here would break every web-side retry.
    expect(submissionBelongsToCaller(null, "driver-1")).toBe(true);
    expect(submissionBelongsToCaller(undefined, "driver-2")).toBe(true);
    expect(submissionBelongsToCaller(null, null)).toBe(true);
  });
});

describe("empty strings", () => {
  it("count as absent, not as a match", () => {
    // Two rows that both carry "" must not be treated as the same driver.
    expect(submissionBelongsToCaller("", "driver-1")).toBe(true);
    expect(submissionBelongsToCaller("driver-1", "")).toBe(true);
  });
});
