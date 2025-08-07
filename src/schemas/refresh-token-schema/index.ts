import { z } from "zod";

const refreshTokenSchema = z.object({
  token: z.string().min(1, "O token é obrigatório!"),
});

export { refreshTokenSchema };
