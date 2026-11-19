import { z } from "zod";

import { createIntegrationDeliverySchema } from "@/schemas/create-integration-delivery-schema";
import { INTEGRATION_IDEMPOTENCY_KEY_PATTERN } from "@/modules/integration/usecases/create-delivery/integration-idempotency-key";
import { validationError } from "@/shared/validation/validation-error";

/**
 * The body of POST /integration/v1/deliveries/batch (plano-escala U-04,
 * F4.5): up to MAX_BATCH_DELIVERIES deliveries, each the body of the
 * single create plus its own `idempotency_key`.
 *
 * Only the envelope is parsed here, and refusing it refuses the whole
 * call (400): not a list, empty, or longer than the ceiling. Each element
 * is parsed on its own by the use case, with the single create's parser,
 * so one bad delivery is that delivery's 400 and the others still go.
 */

/** Deliveries per call: what one request and its transactions may hold. */
const MAX_BATCH_DELIVERIES = 100;

const TOO_MANY_BATCH_DELIVERIES = `Envie no máximo ${MAX_BATCH_DELIVERIES} entregas por lote; para mais, divida em outras chamadas.`;

const batchEnvelopeSchema = z
  .object({
    // The limit first: the length is refused before any element is read.
    deliveries: z
      .array(z.unknown())
      .min(1, "Envie ao menos uma entrega em `deliveries`.")
      .max(MAX_BATCH_DELIVERIES, TOO_MANY_BATCH_DELIVERIES),
  })
  .strict();

type BatchEnvelope = { deliveries: unknown[] };

/** The envelope, or the 400 VALIDATION_ERROR of the whole call. */
function parseBatchEnvelope(body: unknown): BatchEnvelope {
  const parsed = batchEnvelopeSchema.safeParse(body);

  if (parsed.success) return parsed.data;

  throw validationError(
    parsed.error.issues.map((issue) => ({
      ...issue,
      message:
        issue.code === "unrecognized_keys"
          ? `corpo: campo não reconhecido: ${issue.keys.join(", ")}.`
          : `${issue.path.length > 0 ? issue.path.join(".") : "corpo"}: ${issue.message}`,
    })),
  );
}

/**
 * One element as the reference publishes it (documentation only: the use
 * case parses each element with the single create's own parser).
 */
const batchDeliveryDocumentation = createIntegrationDeliverySchema.extend({
  idempotency_key: z
    .string()
    .regex(INTEGRATION_IDEMPOTENCY_KEY_PATTERN)
    .describe(
      "OBRIGATÓRIA, por entrega: o que o cabeçalho Idempotency-Key é na criação de uma entrega só, com as mesmas regras (8 a 128 caracteres entre letras, números e . _ : -; única por empresa). Repita o mesmo valor ao reenviar a mesma entrega, num lote ou numa chamada avulsa.",
    ),
});

const batchBodyDocumentation = z
  .object({
    deliveries: z
      .array(batchDeliveryDocumentation)
      .min(1)
      .max(MAX_BATCH_DELIVERIES)
      .describe(
        `De 1 a ${MAX_BATCH_DELIVERIES} entregas, cada uma com o corpo da criação avulsa e a sua \`idempotency_key\`.`,
      ),
  })
  .strict();

export {
  MAX_BATCH_DELIVERIES,
  TOO_MANY_BATCH_DELIVERIES,
  batchBodyDocumentation,
  batchDeliveryDocumentation,
  parseBatchEnvelope,
};
export type { BatchEnvelope };
