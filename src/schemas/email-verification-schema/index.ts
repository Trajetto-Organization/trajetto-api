import { z } from "zod";

const emailVerificationVerificationSchema = z.object({
  token: z.string().min(1, "O token é obrigatório!"),
});

export { emailVerificationVerificationSchema };
