import { describe, expect, it } from "vitest";

import { toMailDeliveryError } from "@/shared/providers/mail-provider/errors/mail-delivery-error";

/**
 * Whether the pipeline tries an e-mail again, by what the transport said.
 *
 * A stack without RESEND_SECRET_KEY fails as EAUTH ('Missing credentials for
 * "PLAIN"', resend-transport.test.ts), never retried. ENOAUTH, nodemailer 8's
 * name for the old NoAuth, only comes from verify() with no auth under
 * forceAuth, which our transports never set; it is listed as a defence.
 * nodemailer 10 adds the refusals of disableFileAccess / disableUrlAccess
 * (EFILEACCESS, EURLACCESS) and ECONFIG: each replays the same way on every
 * attempt, so none may burn the retry budget.
 */
function transportError(fields: { code?: string; responseCode?: number }) {
  return Object.assign(new Error("transport failure"), fields);
}

describe("toMailDeliveryError", () => {
  it.each([
    "EAUTH",
    "ENOAUTH",
    "EENVELOPE",
    "EMESSAGE",
    "ETLS",
    "EFILEACCESS",
    "EURLACCESS",
    "ECONFIG",
  ])("does not retry %s: the same send gets the same refusal", (code) => {
    const error = toMailDeliveryError(transportError({ code }), "Falha");

    expect(error.retryable).toBe(false);
    expect(error.code).toBe(code);
  });

  it.each(["ETIMEDOUT", "ECONNECTION", "ESOCKET", "EDNS"])(
    "retries %s: the message never reached a server that judged it",
    (code) => {
      expect(
        toMailDeliveryError(transportError({ code }), "Falha").retryable,
      ).toBe(true);
    },
  );

  it("lets the SMTP reply decide over the transport code", () => {
    // EENVELOPE covers both a full mailbox (4xx) and an unknown one (5xx).
    expect(
      toMailDeliveryError(
        transportError({ code: "EENVELOPE", responseCode: 452 }),
        "Falha",
      ).retryable,
    ).toBe(true);

    expect(
      toMailDeliveryError(
        transportError({ code: "ETIMEDOUT", responseCode: 550 }),
        "Falha",
      ).retryable,
    ).toBe(false);
  });
});
