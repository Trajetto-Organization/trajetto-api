import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { buildLogger } from "@/shared/logging/logger";

/**
 * What the driver's ways in must never leave in a log (plan of 02/11/2026,
 * D2/D3): the password a manager sets for a driver, and the access QR code
 * and short code, which open a session while they live. A body, a user or an
 * answer logged whole — top level or one level down — has them censored by
 * name, in the pattern of provider-secret-redaction.
 */
function capture(): { lines: string[]; sink: Writable } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });

  return { lines, sink };
}

describe("the process logger and the driver's credentials", () => {
  it.each([
    ["password", "Inicial-7781"],
    ["qrToken", "Zx3c0Rk1q8W6m4Pe9_tq2D7vA-5sY1bN0hU3jL8fK6o"],
    ["qrContent", "trajetto-enroll:1:staging:Zx3c0Rk1q8W6m4Pe9_tq2D7vA"],
    ["accessCode", "KQ7M-R2XH"],
  ])("censors %s in a body or an answer", (field, value) => {
    const { lines, sink } = capture();
    const log = buildLogger(sink);

    log.info({ [field]: value }, "top");
    log.info({ body: { [field]: value } }, "body");
    log.info({ response: { [field]: value } }, "answer");

    expect(lines).toHaveLength(3);

    for (const line of lines) {
      expect(line).not.toContain(value);
      expect(line).toContain("[redacted]");
    }
  });
});
