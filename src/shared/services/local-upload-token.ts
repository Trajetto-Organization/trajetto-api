import crypto from "node:crypto";

import { env } from "@/env";
import { AppError } from "@/shared/errors/AppError";

interface LocalUploadClaims {
  key: string;
  contentType: string;
  size: number;
  expiresAt: number;
}

/**
 * Stands in for an R2 presigned URL when storage is local.
 *
 * Without this, development has no upload at all: `createPresignedUpload`
 * refuses to sign when there is no bucket, so every form would fail on
 * localhost while working in production — the one place you cannot debug it.
 *
 * The token carries the same guarantees the R2 signature does, and for the same
 * reason: the client is handed a URL and must not be able to change what it
 * writes. Key, content type and byte count are all signed, so the local upload
 * route can enforce them exactly as the bucket would.
 */
function signLocalUploadToken(claims: LocalUploadClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifyLocalUploadToken(token: string): LocalUploadClaims {
  const [payload, signature] = token.split(".");

  if (!payload || !signature) {
    throw new AppError(
      "Token de upload inválido.",
      400,
      "UPLOAD_TOKEN_INVALID",
    );
  }

  const expected = crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(payload)
    .digest("base64url");

  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);

  // Length check first: `timingSafeEqual` throws on a mismatch instead of
  // returning false.
  if (
    provided.length !== computed.length ||
    !crypto.timingSafeEqual(provided, computed)
  ) {
    throw new AppError(
      "Token de upload inválido.",
      400,
      "UPLOAD_TOKEN_INVALID",
    );
  }

  let claims: LocalUploadClaims;

  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new AppError(
      "Token de upload inválido.",
      400,
      "UPLOAD_TOKEN_INVALID",
    );
  }

  if (claims.expiresAt < Date.now()) {
    throw new AppError(
      "A autorização de upload expirou. Tente novamente.",
      400,
      "UPLOAD_TOKEN_EXPIRED",
    );
  }

  return claims;
}

export { signLocalUploadToken, verifyLocalUploadToken };
export type { LocalUploadClaims };
