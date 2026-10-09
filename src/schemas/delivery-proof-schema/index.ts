import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";
import { occurredAtField } from "@/shared/delivery/occurred-at";
import { optionalCoordinate } from "@/shared/delivery/optional-coordinate";
import { devicePrecheckField } from "@/shared/ai-precheck/device-precheck";

/**
 * Proof of delivery from the driver app. The photo and signature are
 * storage keys from the presigned flow — the bytes never touch the API;
 * ownership and existence are verified against the bucket before the keys
 * become rows.
 */
const deliveryProofSchema = z.object({
  ...tenantLockedShape,
  client_submission_id: z
    .string({
      required_error: "A chave de idempotência do envio é obrigatória.",
    })
    .uuid("A chave de idempotência do envio é inválida.")
    .describe(
      "Chave de idempotência do envio (UUID), gerada uma vez pelo app e repetida em cada retentativa: reenviar a mesma chave não comprova a entrega duas vezes.",
    ),
  photo: z
    .string({ required_error: "A foto do canhoto é obrigatória." })
    .min(1, "A foto do canhoto é obrigatória.")
    .max(512),
  signature: z.string().min(1).max(512).optional(),
  received_by: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z
      .string()
      .max(150, "O nome de quem recebeu deve ter no máximo 150 caracteres.")
      .superRefine((value, ctx) => {
        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome de quem recebeu não deve conter espaços consecutivos.",
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "O nome de quem recebeu não pode começar ou terminar com espaço em branco.",
          });
        }
      })
      .optional(),
  ),
  latitude: optionalCoordinate(90),
  longitude: optionalCoordinate(180),
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
  // Decision 14.2: a build with the pre-check may still post a day cached
  // before the delivery types here.
  device_precheck: devicePrecheckField,
});

export { deliveryProofSchema };
