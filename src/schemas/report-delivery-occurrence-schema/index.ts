import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import { occurredAtField } from "@/shared/delivery/occurred-at";
import { optionalCoordinate } from "@/shared/delivery/optional-coordinate";
import { devicePrecheckField } from "@/shared/ai-precheck/device-precheck";
import {
  hasInlineConsecutiveSpaces,
  hasSpaceAtLineEdges,
} from "@/shared/delivery/text-rules";

const reportDeliveryOccurrenceSchema = z.object({
  ...tenantLockedShape,
  occurrenceTypeId: z.string().min(1, "O tipo de ocorrência é obrigatório."),
  description: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z
      .string()
      .max(500, "A descrição deve ter no máximo 500 caracteres.")
      // Multiline (decision 5.5): a blank line between "Cliente ausente." and
      // "Vizinho informou" is two paragraphs. The old single-line rule refused it, and from the
      // driver's offline queue a 400 is a permanent failure.
      .superRefine((value, ctx) => {
        if (hasInlineConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A descrição não deve conter espaços consecutivos.",
          });

          return;
        }

        if (value !== value.trim() || hasSpaceAtLineEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "A descrição não pode começar ou terminar com espaço em branco.",
          });
        }
      })
      .optional(),
  ),
  latitude: optionalCoordinate(90),
  longitude: optionalCoordinate(180),
  // Storage keys from the presigned flow — ownership and existence are
  // verified against the bucket before they become rows.
  photos: z
    .array(z.string().min(1).max(512))
    .max(5, "No máximo 5 fotos por ocorrência.")
    .optional(),
  client_submission_id: z
    .string()
    .uuid("A chave de idempotência do envio é inválida.")
    .optional()
    .describe(
      "Chave de idempotência do envio (UUID), gerada uma vez pelo app e repetida em cada retentativa: reenviar a mesma chave não registra a ocorrência duas vezes.",
    ),
  occurred_at: occurredAtField,
  // Decision 14.8 (design §7.2): printed on the proof document. Advisory:
  // what cannot be read is dropped, never refused.
  photo_taken_at: z
    .string()
    .max(64)
    .optional()
    .catch(undefined)
    .describe(
      "Quando a foto do canhoto foi tirada (ISO 8601), pelo relógio do aparelho. Corrigido pelo X-Client-Sent-At como occurred_at; nunca depois de occurred_at nem mais de 7 dias no passado. Ilegível: ignorado.",
    ),
  device_id: z
    .string()
    .max(64)
    .optional()
    .catch(undefined)
    .describe(
      "Identificador do celular (Android ID de 16 dígitos hexadecimais, ou um UUID guardado no aparelho). Outro formato: ignorado, nunca recusado.",
    ),
  // Decision 6.2. The shape only (key → primitive, bounded); the answers are
  // checked against the type's current form in the use case.
  form_answers: z
    .record(
      z.string().max(40),
      z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]),
    )
    .refine((answers) => Object.keys(answers).length <= 50, {
      message: "Respostas demais para um formulário de ocorrência.",
    })
    .nullable()
    .optional()
    .describe(
      "Respostas do formulário do tipo, por `key` do campo: texto e lista como string, número como number, sim/não como boolean, data como `AAAA-MM-DD`. Validadas contra o formulário ATUAL do tipo; inválidas → 400 OCCURRENCE_FORM_INVALID com `field_errors`.",
    ),
  // Decision 14.3: a DELIVERED type proves the delivery with these. Keys of
  // the presigned flow, like `photos`; dropped (not refused) when the type's
  // category does not take them.
  receipt_photo: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      "Chave da foto do canhoto (PUT pré-assinado em deliveryPhotos). Exigida quando o tipo tem `requires_receipt_photo` → senão 400 OCCURRENCE_RECEIPT_PHOTO_REQUIRED.",
    ),
  signature: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      "Chave da assinatura na tela (PNG, PUT pré-assinado em deliveryPhotos). Exigida quando o tipo tem `requires_signature` → senão 400 OCCURRENCE_SIGNATURE_REQUIRED.",
    ),
  received_by: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z
      .string()
      .max(150, "O nome de quem recebeu deve ter no máximo 150 caracteres.")
      .superRefine((value, ctx) => {
        if (hasInlineConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome de quem recebeu não deve conter espaços consecutivos.",
          });

          return;
        }

        if (value !== value.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome de quem recebeu não pode começar ou terminar com espaço em branco.",
          });
        }
      })
      .optional()
      .describe("Só em tipos de entrega (DELIVERED): quem recebeu. Opcional."),
  ),
  form_version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "A `form_version` do tipo que o app exibiu. Se o formulário mudou e as respostas não servem mais → 409 OCCURRENCE_FORM_OUTDATED com o formulário atual.",
    ),
  // Decision 14.2: the phone's offline check of the receipt photo. Only read
  // on a DELIVERED report that carries a receipt; dropped everywhere else.
  device_precheck: devicePrecheckField,
});

export { reportDeliveryOccurrenceSchema };
