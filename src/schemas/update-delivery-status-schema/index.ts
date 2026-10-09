import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";
import { optionalMultilineText } from "@/shared/delivery/text-rules";

const RECEIVED_BY_MIN = 2;
const RECEIVED_BY_MAX = 150;

const updateDeliveryStatusSchema = z
  .object({
    ...tenantLockedShape,
    status: z.enum(
      ["PENDING", "IN_TRANSIT", "DELIVERED", "FAILED", "CANCELLED"],
      {
        errorMap: () => ({
          message:
            "Status inválido. Deve ser PENDING, IN_TRANSIT, DELIVERED, FAILED ou CANCELLED.",
        }),
      },
    ),
    received_by: z.preprocess(
      (val) => (val === "" ? undefined : val),
      z
        .string()
        .max(
          RECEIVED_BY_MAX,
          "O nome de quem recebeu deve ter no máximo 150 caracteres.",
        )
        .superRefine((value, ctx) => {
          if (value.trim().length < RECEIVED_BY_MIN) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "O nome de quem recebeu deve ter no mínimo 2 caracteres.",
            });

            return;
          }

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
        .optional()
        .describe(
          "Quem recebeu a mercadoria. Obrigatório em DELIVERED: a baixa pelo painel não tem foto nem assinatura, e o nome é o que a sustenta.",
        ),
    ),

    /**
     * Required, and this is the one endpoint in the module that demands it.
     *
     * Everything the driver's app does carries its own evidence — a photo, a
     * geolocation, a typed occurrence. Moving a status by hand from the panel
     * carries none, so the reason IS the evidence, and three days later it is
     * the only thing support has to answer "por que essa está assim?".
     */
    reasonId: z
      .string({ required_error: "Informe o motivo da mudança de status." })
      .uuid("O motivo deve ter um identificador válido.")
      .describe("Do catálogo da empresa, e apenas motivos ativos."),

    /** The detail the catalogue cannot carry: "cliente ligou às 14h". */
    note: optionalMultilineText("A anotação", 500),
  })
  // Decision 5.3: marking a delivery as delivered from the panel has no photo
  // or signature behind it; the name of who received it is the evidence, and
  // it is what {{recebido_por}} prints to the customer.
  .superRefine((body, ctx) => {
    if (body.status === "DELIVERED" && !body.received_by) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["received_by"],
        message: "Informe quem recebeu a entrega.",
      });
    }
  });

export { updateDeliveryStatusSchema };
