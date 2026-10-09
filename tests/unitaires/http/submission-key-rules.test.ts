import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { idempotencyKeyOf, isUniqueViolation } from "@/shared/http/idempotency-key";
import { submissionKeyOf } from "@/shared/http/submission-key";

/**
 * The key a submission is looked up by, before its body is validated
 * (mutation run 06/10: no unit test reached these; only E2E suites did).
 */

const BODY_KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const HEADER_KEY = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("submissionKeyOf", () => {
  it("takes the body's key over the header's", () => {
    expect(submissionKeyOf({ client_submission_id: BODY_KEY }, HEADER_KEY)).toBe(BODY_KEY);
  });

  it("falls back to the header without a body key, or without an object body", () => {
    expect(submissionKeyOf({ client_submission_id: "" }, HEADER_KEY)).toBe(HEADER_KEY);
    expect(submissionKeyOf(null, HEADER_KEY)).toBe(HEADER_KEY);
    expect(submissionKeyOf("text body", HEADER_KEY)).toBe(HEADER_KEY);
    expect(submissionKeyOf(undefined, HEADER_KEY)).toBe(HEADER_KEY);
  });

  it("returns only a well-formed UUID", () => {
    expect(submissionKeyOf({ client_submission_id: "not-a-uuid" }, HEADER_KEY)).toBeUndefined();
    expect(submissionKeyOf({}, undefined)).toBeUndefined();
  });
});

describe("idempotencyKeyOf", () => {
  it("reads the Idempotency-Key header when it is a UUID", () => {
    expect(idempotencyKeyOf({ "idempotency-key": HEADER_KEY })).toBe(HEADER_KEY);
    expect(idempotencyKeyOf({ "idempotency-key": "abc" })).toBeUndefined();
    expect(idempotencyKeyOf({})).toBeUndefined();
  });
});

describe("isUniqueViolation", () => {
  const prismaError = (code: string) =>
    new Prisma.PrismaClientKnownRequestError("refused", { code, clientVersion: "test" });

  it("is a Prisma P2002 and nothing else", () => {
    expect(isUniqueViolation(prismaError("P2002"))).toBe(true);
    expect(isUniqueViolation(prismaError("P2025"))).toBe(false);
    expect(isUniqueViolation({ code: "P2002" })).toBe(false);
    expect(isUniqueViolation(new Error("P2002"))).toBe(false);
  });
});
