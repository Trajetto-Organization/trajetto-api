import { describe, expect, it } from "vitest";

import {
  signLocalUploadToken,
  verifyLocalUploadToken,
} from "@/shared/services/local-upload-token";

import { AppError } from "@/shared/errors/AppError";

const validClaims = {
  key: "checklistPhotos/business-1/123-photo.jpg",
  contentType: "image/jpeg",
  size: 2048,
  expiresAt: Date.now() + 60_000,
};

/**
 * The local upload route stands in for the storage bucket in development, so
 * this token stands in for the R2 signature. It has to hold the same line: what
 * the client writes, where, and how much, are all fixed at signing time.
 */
describe("local upload token", () => {
  it("round-trips the claims it was given", () => {
    const claims = verifyLocalUploadToken(signLocalUploadToken(validClaims));

    expect(claims).toEqual(validClaims);
  });

  it("rejects a token whose payload was edited", () => {
    const token = signLocalUploadToken(validClaims);
    const [, signature] = token.split(".");

    // The key now points at another company, with the original signature.
    const forged = Buffer.from(
      JSON.stringify({
        ...validClaims,
        key: "checklistPhotos/business-2/stolen.jpg",
      }),
    ).toString("base64url");

    expect(() => verifyLocalUploadToken(`${forged}.${signature}`)).toThrow(
      AppError,
    );
  });

  it("rejects a token with a forged signature", () => {
    const [payload] = signLocalUploadToken(validClaims).split(".");

    expect(() => verifyLocalUploadToken(`${payload}.not-a-signature`)).toThrow(
      AppError,
    );
  });

  it("rejects an expired token", () => {
    const token = signLocalUploadToken({
      ...validClaims,
      expiresAt: Date.now() - 1,
    });

    expect(() => verifyLocalUploadToken(token)).toThrow(
      expect.objectContaining({ code: "UPLOAD_TOKEN_EXPIRED" }),
    );
  });

  it("rejects a malformed token instead of throwing something unhandled", () => {
    for (const token of ["", "no-dot", "a.b.c.d"]) {
      expect(() => verifyLocalUploadToken(token)).toThrow(AppError);
    }
  });
});
