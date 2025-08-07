import { z } from "zod";

const forgotPasswordVerificationSchema = z.object({
  token: z.string().min(1, "O token é obrigatório!"),
});

export { forgotPasswordVerificationSchema };
