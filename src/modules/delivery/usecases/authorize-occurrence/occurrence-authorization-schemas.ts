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
      error: "Decida entre APPROVED (autorizar) e DENIED (negar).",
    })
    .describe(
      "APPROVED aplica o efeito do tipo agora; DENIED não aplica nada.",
    ),
  // Multiline (decision 5.5): what the driver reads on the phone.
  note: optionalMultilineText("O motivo", 500).describe(
    "Obrigatório ao negar (é o que o motorista lê); opcional ao autorizar.",
  ),
});

/**
 * GET /delivery/occurrence-authorizations — the MASTER names the company.
 *
 * `view` and `occurrenceId` are the app's (wave 4): a list it polls every
 * 30 s without signing every photo of the queue, and the one request a push
 * opens. Absent, the web's queue is exactly what it was.
 */
const listPendingAuthorizationsSchema = z.object({
  businessId: z
    .string()
    .uuid("Empresa inválida.")
    .optional()
    .describe(
      "Só o MASTER envia: a empresa da fila. Os demais leem sempre a própria empresa.",
    ),
  view: z
    .enum(["full", "summary"], { error: "Escolha a visão full ou summary." })
    .default("full")
    .describe(
      "full (padrão, a fila da torre na web): cada pedido com as fotos assinadas, o formulário e as respostas. summary (o app): a linha da lista, sem URL assinada nem formulário, com `photos_count`, `has_receipt_photo` e `has_signature`; o detalhe pede `occurrenceId` na visão full.",
    ),
  occurrenceId: z
    .string()
    .uuid("Ocorrência inválida.")
    .optional()
    .describe(
      "Só este pedido, se ainda aguarda (o detalhe aberto por um aviso). Já decidido, encerrado ou de outra empresa: `data` vazio e `total` 0, a mesma resposta de um ID que não existe.",
    ),
});

export {
  decideOccurrenceAuthorizationSchema,
  listPendingAuthorizationsSchema,
  occurrenceAuthorizationParamsSchema,
};
