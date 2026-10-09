import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import { optionalMultilineText } from "@/shared/delivery/text-rules";

/** POST /delivery/occurrence-authorization/:occurrenceId/business/:businessId */
const occurrenceAuthorizationParamsSchema = z.object({
  occurrenceId: z.string().uuid("Ocorrência inválida."),
  businessId: z.string().uuid("Empresa inválida."),
});

const decideOccurrenceAuthorizationSchema = z.object({
  ...tenantLockedShape,
  decision: z
    .enum(["APPROVED", "DENIED"], {
      errorMap: () => ({ message: "Decida entre APPROVED (autorizar) e DENIED (negar)." }),
    })
    .describe("APPROVED aplica o efeito do tipo agora; DENIED não aplica nada."),
  // Multiline (decision 5.5): what the driver reads on the phone.
  note: optionalMultilineText("O motivo", 500).describe(
    "Obrigatório ao negar (é o que o motorista lê); opcional ao autorizar.",
  ),
});

/** GET /delivery/occurrence-authorizations — the MASTER names the company. */
const listPendingAuthorizationsSchema = z.object({
  businessId: z
    .string()
    .uuid("Empresa inválida.")
    .optional()
    .describe(
      "Só o MASTER envia: a empresa da fila. Os demais leem sempre a própria empresa.",
    ),
});

export {
  decideOccurrenceAuthorizationSchema,
  listPendingAuthorizationsSchema,
  occurrenceAuthorizationParamsSchema,
};
