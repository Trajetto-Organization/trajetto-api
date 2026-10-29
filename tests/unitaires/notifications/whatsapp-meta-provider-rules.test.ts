import { describe, expect, it } from "vitest";

import {
  classifyMetaError,
  normalizePhoneNumber,
  parseRetryAfterSeconds,
  REQUEST_TIMEOUT_MS,
} from "@/shared/providers/whatsapp-provider/implementations/meta-cloud-api-provider";

describe("normalizePhoneNumber", () => {
  /**
   * The regression that motivated the rewrite: area code 55 (Santa Maria/RS)
   * makes a local number literally start with "55", so the old prefix check
   * read it as already carrying the country code and sent 11 digits to Meta.
   */
  it("prefixes 55 on an area-code-55 mobile instead of reading it as a country code", () => {
    expect(normalizePhoneNumber("(55) 99123-4567")).toBe("5555991234567");
    expect(normalizePhoneNumber("55991234567")).toBe("5555991234567");
  });

  it("prefixes 55 on a 10-digit landline", () => {
    expect(normalizePhoneNumber("(11) 3123-4567")).toBe("551131234567");
    expect(normalizePhoneNumber("5533334444")).toBe("555533334444");
  });

  it("prefixes 55 on an 11-digit mobile from any other area code", () => {
    expect(normalizePhoneNumber("(11) 99123-4567")).toBe("5511991234567");
  });

  it("keeps a number that already carries the Brazilian country code", () => {
    expect(normalizePhoneNumber("+55 (11) 99123-4567")).toBe("5511991234567");
    expect(normalizePhoneNumber("+55 (55) 99123-4567")).toBe("5555991234567");
    expect(normalizePhoneNumber("+55 11 3123-4567")).toBe("551131234567");
  });

  /**
   * A length outside the Brazilian plans belongs to another country: the
   * digits go out untouched rather than gaining an invented "55".
   */
  it("leaves a foreign number alone instead of inventing a country code", () => {
    expect(normalizePhoneNumber("+351 912 345 678")).toBe("351912345678");
    expect(normalizePhoneNumber("+44 20 7946 0958")).toBe("442079460958");
    // 13 digits, but not a Brazilian country code — no rewriting either.
    expect(normalizePhoneNumber("+86 138 0013 8000")).toBe("8613800138000");
  });

  /**
   * Pinning the documented limitation rather than pretending it away: a
   * foreign number that happens to be 10 or 11 digits long is
   * indistinguishable from a local Brazilian one, and length wins because
   * every recipient of this product is Brazilian.
   */
  it("still treats an 11-digit foreign number as Brazilian, by design", () => {
    expect(normalizePhoneNumber("+1 415 555 2671")).toBe("5514155552671");
  });

  it("strips every non-digit character before deciding", () => {
    expect(normalizePhoneNumber(" +55 (11) 9.9123-4567 ")).toBe(
      "5511991234567",
    );
  });
});

describe("classifyMetaError", () => {
  it("retries a rate limit", () => {
    expect(classifyMetaError({ httpStatus: 429 }).retryable).toBe(true);
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 130429 }).retryable,
    ).toBe(true);
  });

  it("retries a server-side failure", () => {
    expect(classifyMetaError({ httpStatus: 500 }).retryable).toBe(true);
    expect(classifyMetaError({ httpStatus: 503 }).retryable).toBe(true);
  });

  it("retries a network or timeout failure, which says nothing about the message", () => {
    expect(classifyMetaError({ networkError: true }).retryable).toBe(true);
  });

  /**
   * 131026 is the recipient having no WhatsApp at all — five identical
   * attempts produce five identical rejections.
   */
  it("does not retry an undeliverable recipient (131026)", () => {
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 131026 }).retryable,
    ).toBe(false);
  });

  it("does not retry a template problem (132001)", () => {
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 132001 }).retryable,
    ).toBe(false);
  });

  it("does not retry outside the 24h window (131047) nor a locked account (131031)", () => {
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 131047 }).retryable,
    ).toBe(false);
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 131031 }).retryable,
    ).toBe(false);
  });

  it("does not retry an invalid or unauthorized token", () => {
    expect(classifyMetaError({ httpStatus: 401 }).retryable).toBe(false);
    expect(classifyMetaError({ httpStatus: 403 }).retryable).toBe(false);
  });

  /** Fallback rule: an unmapped 4xx is Meta refusing this exact payload. */
  it("treats an unknown code on a 4xx as permanent", () => {
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 999999 }).retryable,
    ).toBe(false);
  });

  /** Fallback rule, other half: an unmapped 5xx is still Meta's problem. */
  it("treats an unknown code on a 5xx as transient", () => {
    expect(
      classifyMetaError({ httpStatus: 502, errorCode: 999999 }).retryable,
    ).toBe(true);
  });

  it("lets the Meta code override the HTTP status in both directions", () => {
    // Throttling arriving as a plain 400 must still be retried...
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 131048 }).retryable,
    ).toBe(true);
    // ...and a permanent template error wrapped in a 500 must not be.
    expect(
      classifyMetaError({ httpStatus: 500, errorCode: 132016 }).retryable,
    ).toBe(false);
  });

  /**
   * A paused template (132015) is Meta's temporary state — 3 h the first time,
   * 6 h the second — not a verdict on the message. Failing each delivery on
   * it lost every WhatsApp of every tenant sent during the pause.
   */
  it("retries a paused template, and says it is a pause", () => {
    const classification = classifyMetaError({
      httpStatus: 400,
      errorCode: 132015,
    });

    expect(classification.retryable).toBe(true);
    expect(classification.paused).toBe(true);
  });

  it("keeps a disabled template (132016) and a restricted account (131031) terminal", () => {
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 132016 }).retryable,
    ).toBe(false);
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 131031 }).retryable,
    ).toBe(false);
  });

  it("explains which rule decided", () => {
    expect(classifyMetaError({ httpStatus: 429 }).reason).toContain("429");
    expect(
      classifyMetaError({ httpStatus: 400, errorCode: 131026 }).reason,
    ).toContain("131026");
  });
});

describe("parseRetryAfterSeconds", () => {
  it("reads the numeric delay Meta sends", () => {
    expect(parseRetryAfterSeconds("30")).toBe(30);
    expect(parseRetryAfterSeconds(" 12 ")).toBe(12);
  });

  it("rounds a fractional delay up so the wait is never too short", () => {
    expect(parseRetryAfterSeconds("1.2")).toBe(2);
  });

  it("ignores an absent or non-numeric header instead of guessing", () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds("")).toBeUndefined();
    expect(parseRetryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(
      undefined,
    );
    expect(parseRetryAfterSeconds("-5")).toBeUndefined();
  });
});

describe("request timeout", () => {
  /**
   * The pipeline's per-delivery backstop is 15s. A provider timeout at or
   * above that can never fire first, so the call would be killed from outside
   * and its failure would lose the retry classification this file exists to
   * produce.
   */
  it("fires before the pipeline's 15s per-delivery backstop", () => {
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(15_000);
  });
});
