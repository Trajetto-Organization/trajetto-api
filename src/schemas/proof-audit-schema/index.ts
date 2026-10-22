import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

/**
 * The highest page the queue answers. Keeps `(page - 1) * pageSize` inside
 * Prisma's 32-bit `skip` at the largest page size (10^6 × 100 < 2^31): past
 * it the value reached the database and came back as a 500.
 */
const MAX_PROOF_AUDIT_PAGE = 1_000_000;

const listProofAuditsSchema = z.object({
  // Junk and zero still fall back to the default, like every offset list;
  // a fraction does not: page=2.5 became OFFSET 4.5 and a 500.
  page: z
    .string()
    .transform((value) => Number(value) || 1)
    .refine(
      (value) =>
        Number.isInteger(value) && value >= 1 && value <= MAX_PROOF_AUDIT_PAGE,
      "A página deve ser um número inteiro a partir de 1.",
    )
    .describe(
      "Página, inteiro de 1 a 1.000.000; vazio, zero ou não numérico vira 1; fração, negativo ou acima do limite: 400 VALIDATION_ERROR.",
    ),
  pageSize: z
    .string()
    .transform((value) => Number(value) || 10)
    .refine(
      (value) => Number.isInteger(value) && value >= 1 && value <= 100,
      "A quantidade de itens por página deve ser um número inteiro entre 1 e 100.",
    )
    .describe(
      "Itens por página, inteiro de 1 a 100; vazio, zero ou não numérico vira 10; fração, negativo ou acima de 100: 400 VALIDATION_ERROR.",
    ),

  status: z
    .enum(["PENDING", "APPROVED", "REJECTED"])
    .optional()
    .default("PENDING")
    .describe("A fila pedida; padrão PENDING, os que esperam revisão."),

  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe("Só o MASTER envia; ausente, a empresa do usuário."),
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
  ...tenantLockedShape,
  status: z.enum(["APPROVED", "REJECTED"], {
    errorMap: () => ({ message: "A decisão deve ser APPROVED ou REJECTED." }),
  }),

  /**
   * Required on a rejection, and the use case is what enforces it — a schema
   * cannot express "required only when the other field says so" without a
   * refinement that produces a worse message than the sentence the use case
   * already writes.
   *
   * No length here: the use case trims first and judges 5–500 on what is
   * left (checkRejectionReason). Measured here, untrimmed, "abc" got a
   * VALIDATION_ERROR while "   abcd   " got INVALID_REJECTION_REASON, and a
   * 498-character reason with trailing blanks was refused as too long.
   */
  rejection_reason: z
    .preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z
        .string({
          invalid_type_error: "O motivo da rejeição deve ser um texto.",
        })
        .optional(),
    )
    .describe(
      "Obrigatório para REJECTED. Espaços nas pontas são removidos; depois disso, de 5 a 500 caracteres, sem espaços consecutivos dentro de uma linha (quebras de linha são mantidas). Fora da regra: 400 INVALID_REJECTION_REASON; ausente numa rejeição: 400 REJECTION_REASON_REQUIRED.",
    ),
});

export {
  MAX_PROOF_AUDIT_PAGE,
  listProofAuditsSchema,
  reviewProofAuditParamsSchema,
  reviewProofAuditSchema,
};
