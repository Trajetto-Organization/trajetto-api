import { AppError } from "@/shared/errors/AppError";

/**
 * The public create's `Idempotency-Key`, which is REQUIRED (decision 5.10).
 *
 * On the panel the key is optional because a person sees the result and can
 * look before saving again. An ERP cannot: its push queue retries on every
 * timeout, and a create without a key is a duplicate delivery the first time
 * our answer is lost on the way back. Refusing the request is cheaper than
 * explaining two trucks at the same door.
 *
 * Letters, digits and `. _ : -`, 8 to 128 characters: a UUID fits, and so
 * does a key the ERP derives from its own document (`pedido-10452`), which
 * survives an ERP restart without the ERP storing anything. Bounded because it
 * is a column in a unique index.
 */
const INTEGRATION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

class IdempotencyKeyRequiredError extends AppError {
  constructor() {
    super(
      "Envie o cabeçalho Idempotency-Key: um valor único por entrega, repetido em cada nova tentativa do mesmo envio.",
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
}

class IdempotencyKeyInvalidError extends AppError {
  constructor() {
    super(
      "Idempotency-Key inválida: use de 8 a 128 caracteres entre letras, números e . _ : - (um UUID serve).",
      400,
      "IDEMPOTENCY_KEY_INVALID",
    );
  }
}

/** Reads the header or refuses; a repeated header is not one key. */
function readIntegrationIdempotencyKey(
  headers: Record<string, unknown>,
): string {
  const raw = headers["idempotency-key"];

  if (raw === undefined || raw === "") throw new IdempotencyKeyRequiredError();

  if (typeof raw !== "string" || !INTEGRATION_IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new IdempotencyKeyInvalidError();
  }

  return raw;
}

export {
  INTEGRATION_IDEMPOTENCY_KEY_PATTERN,
  IdempotencyKeyInvalidError,
  IdempotencyKeyRequiredError,
  readIntegrationIdempotencyKey,
};
