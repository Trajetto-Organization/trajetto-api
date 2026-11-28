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

/**
 * Plano-escala F3-15c: SMTP has no 429, and Resend's relay does not
 * document the code of its rate refusal ("the rate limit is the same as
 * the API"). The words mark it, whatever the code, so the alert counts it
 * and the bucket can hold the provider; whether it is retried stays the
 * code's decision, as before.
 */
describe("a refusal for rate", () => {
  it.each([
    ["Too many requests. You can only make 10 requests per second.", 451],
    ["rate_limit_exceeded", 550],
    ["Rate limit reached, slow down", undefined],
    ["Message throttled", 421],
    ["429 Too Many Requests", undefined],
  ])("is marked: %s", (text, responseCode) => {
    const error = toMailDeliveryError(
      Object.assign(new Error(text), { responseCode }),
      "Falha",
    );

    expect(error.throttled).toBe(true);
    expect(error.retryable).toBe(
      responseCode === undefined ? true : responseCode < 500,
    );
  });

  it.each([
    ["452 4.2.2 Mailbox full", 452],
    ["450 Greylisted, try again later", 450],
    ["550 5.1.1 User unknown <x@example.com>", 550],
    ["connection reset", undefined],
  ])("is not: %s", (text, responseCode) => {
    expect(
      toMailDeliveryError(
        Object.assign(new Error(text), { responseCode }),
        "Falha",
      ).throttled,
    ).toBe(false);
  });
});
