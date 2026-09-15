import { z } from "zod";

const listProofAuditsSchema = z.object({
  page: z
    .string()
    .transform((value) => Number(value) || 1)
    .refine((value) => value >= 1, "A página é obrigatória!"),
  pageSize: z
    .string()
    .transform((value) => Number(value) || 10)
    .refine(
      (value) => value >= 1 && value <= 100,
      "A quantidade de itens por página deve estar entre 1 e 100.",
    ),

  status: z
    .enum(["PENDING", "APPROVED", "REJECTED"])
    .optional()
    .default("PENDING"),

  businessId: z.string().uuid("ID da empresa é inválido.").optional(),
});

const reviewProofAuditParamsSchema = z.object({
  auditId: z
    .string({ required_error: "ID da auditoria é obrigatório!" })
    .uuid("ID da auditoria é inválido."),
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
});

const reviewProofAuditSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"], {
    errorMap: () => ({ message: "A decisão deve ser APPROVED ou REJECTED." }),
  }),

  /**
   * Required on a rejection, and the use case is what enforces it — a schema
   * cannot express "required only when the other field says so" without a
   * refinement that produces a worse message than the sentence the use case
   * already writes.
   */
  rejection_reason: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .min(5, "O motivo da rejeição deve ter no mínimo 5 caracteres.")
      .max(500, "O motivo da rejeição deve ter no máximo 500 caracteres.")
      .optional(),
  ),
});

export {
  listProofAuditsSchema,
  reviewProofAuditParamsSchema,
  reviewProofAuditSchema,
};
