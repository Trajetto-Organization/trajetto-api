import { z } from "zod";

const proofDocumentParamsSchema = z.object({
  deliveryId: z
    .string({ required_error: "ID da entrega é obrigatório!" })
    .uuid("ID da entrega é inválido."),
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
});

const proofDocumentQuerySchema = z.object({
  /**
   * Rebuilds the document even when one exists.
   *
   * The link a customer already holds keeps working: a regeneration reuses
   * the verification token and bumps the version, so an older printout is
   * identifiable as older rather than broken.
   */
  regenerate: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

/**
 * 64 hex characters, and nothing else reaches the repository.
 *
 * The token is the only thing standing between a printed QR code and somebody
 * else's delivery, so the shape is checked before it becomes a query — a
 * public endpoint that forwards arbitrary strings to a lookup is a public
 * endpoint somebody will use to measure timing.
 */
const verifyProofParamsSchema = z.object({
  token: z
    .string({ required_error: "Código de verificação é obrigatório!" })
    .regex(/^[0-9a-f]{64}$/, "Código de verificação inválido."),
});

export {
  proofDocumentParamsSchema,
  proofDocumentQuerySchema,
  verifyProofParamsSchema,
};
