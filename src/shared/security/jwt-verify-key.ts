import { createSecretKey, type KeyObject } from "node:crypto";

/**
 * The HMAC secret as a KeyObject, built once per secret.
 *
 * jsonwebtoken 9 turns a string secret into a key on EVERY verify, and it
 * tries `createPublicKey` first: OpenSSL 3 walks its PEM/DER decoders over
 * the secret, throws, and only then does it fall back to `createSecretKey`.
 * Every authenticated request verifies twice (the rate-limit key and the
 * session), and under load that failed parse was ~7% of a replica's CPU
 * (docs/desempenho/carga-2026-10.md). A KeyObject skips straight to the HMAC
 * check; the algorithms allowed stay the same (HS256/384/512 for a secret).
 */
const keys = new Map<string, KeyObject>();

function hmacVerifyKey(secret: string | Buffer): KeyObject {
  // Buffers (derived keys) are cached by content, like the env strings.
  const id =
    typeof secret === "string"
      ? `s:${secret}`
      : `b:${secret.toString("base64")}`;
  let key = keys.get(id);

  if (!key) {
    key = createSecretKey(
      typeof secret === "string" ? Buffer.from(secret) : secret,
    );
    keys.set(id, key);
  }

  return key;
}

export { hmacVerifyKey };
