import { z } from "zod";

import { requiredMultilineText } from "@/shared/delivery/text-rules";
import {
  CANCEL_REASON_MAX,
  CANCEL_REASON_MIN,
} from "@/shared/integration/cancel-delivery-rules";
import { validationError } from "@/shared/validation/validation-error";

import {
  issuePath,
  unrecognizedFieldsMessage,
} from "@/schemas/create-integration-delivery-schema";

/**
 * The body of POST /integration/v1/deliveries/:id/cancel (L9, D49).
 *
 * The reason is required: a cancel from the panel carries one from the
 * company's catalogue, and the API's is the integrator's own words — three
 * days later it is the only thing support has to answer "por que essa foi
 * cancelada?". The panel annotation's text rules (a line break is fine; no
 * blank text, no repeated spaces, no space at either end of a line), with a
 * floor. Unknown fields are refused, as on the create: `motivo` silently
 * ignored would be a cancel refused for a reason the ERP never sees.
 */
const cancelIntegrationDeliverySchema = z
  .object(
    {
      reason: requiredMultilineText("O motivo", {
        min: CANCEL_REASON_MIN,
        max: CANCEL_REASON_MAX,
        required: "informe o motivo do cancelamento, em texto.",
      }).describe(
        `Por que a entrega foi cancelada, como o seu sistema diria: "Pedido cancelado pelo cliente no ERP.". De ${CANCEL_REASON_MIN} a ${CANCEL_REASON_MAX} caracteres, sem espaço nas pontas nem espaços seguidos; quebra de linha é aceita. Aparece no histórico da entrega, no aviso ao motorista e no \`data.note\` do evento em /integration/v1/events.`,
      ),
    },
    { message: "envie um objeto JSON com o campo reason." },
  )
  .strict();

type CancelIntegrationDeliveryBody = z.infer<
  typeof cancelIntegrationDeliverySchema
>;

/**
 * Parses the body, or throws the ZodError the error handler turns into
 * 400 VALIDATION_ERROR, each sentence prefixed by its field like the
 * create's. Zod's own sentence for an unknown field is English; it is said
 * here in Portuguese, naming the fields.
 */
function parseCancelIntegrationDeliveryBody(
  body: unknown,
): CancelIntegrationDeliveryBody {
  const parsed = cancelIntegrationDeliverySchema.safeParse(body);

  if (parsed.success) return parsed.data;

  throw validationError(
    parsed.error.issues.map((issue) => ({
      ...issue,
      message: `${issuePath(issue.path)}: ${
        issue.code === z.ZodIssueCode.unrecognized_keys
          ? unrecognizedFieldsMessage(issue.keys)
          : issue.message
      }`,
    })),
  );
}

export { cancelIntegrationDeliverySchema, parseCancelIntegrationDeliveryBody };
export type { CancelIntegrationDeliveryBody };
