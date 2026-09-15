import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
} from "@/shared/utils/zod-schema-helpers";

const updateDeliveryStatusSchema = z.object({
  status: z.enum(["PENDING", "IN_TRANSIT", "DELIVERED", "FAILED", "CANCELLED"], {
    errorMap: () => ({
      message:
        "Status inválido. Deve ser PENDING, IN_TRANSIT, DELIVERED, FAILED ou CANCELLED.",
    }),
  }),
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
      .optional()
      .describe("Quem recebeu a mercadoria — só faz sentido em DELIVERED."),
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
  note: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z
      .string()
      .max(500, "A anotação deve ter no máximo 500 caracteres.")
      .optional(),
  ),
});

export { updateDeliveryStatusSchema };
