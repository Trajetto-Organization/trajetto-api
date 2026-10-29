import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What the code SAYS the notification pipeline guarantees (OUTBOX-20).
 *
 * Operational and product decisions — accepting mass messages to customers,
 * say — are taken on the strength of these comments. Two of them promised
 * more than the code does:
 *
 *   - "N replicas never process the same row at the same time": false once a
 *     worker outlives its lease; fencing makes its late WRITES no-ops, but its
 *     send may already have happened.
 *   - "SMTP has no idempotency key": Resend has one (Resend-Idempotency-Key),
 *     and ResendMailProvider sends the delivery id in it; the deterministic
 *     Message-ID is only the fallback for other transports.
 *
 * The real matrix lives in ADR 0003; these files must not contradict it.
 */
function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const OVERSTATEMENTS = [
  /never process the same/i,
  /SMTP has no idempotency key/i,
  /impossible by construction/i,
  /exactly[- ]once delivery/i,
];

describe("the pipeline's documented guarantees", () => {
  it.each([
    "src/shared/notifications/notification-pipeline-service.ts",
    "src/shared/providers/mail-provider/message-id.ts",
    "tests/unitaires/notifications/delivery-idempotency.test.ts",
    "prisma/schema.prisma",
  ])("are not overstated in %s", (path) => {
    const text = source(path);

    const found = OVERSTATEMENTS.filter((pattern) => pattern.test(text)).map(
      String,
    );

    expect(found).toEqual([]);
  });

  it("name the lease takeover and the fencing, where the claim is described", () => {
    const text = source(
      "src/shared/notifications/notification-pipeline-service.ts",
    );

    expect(text).toMatch(/outlives? its lease/i);
  });
});
