import { z } from "zod";

const authenticateUserSchema = z.object({
  email: z
    .string()
    .min(1, "O e-mail é obrigatório.")
    .email("O e-mail informado não é válido.")
    .max(100, "O e-mail deve ter no máximo 100 caracteres."),
  password: z
    .string()
    .min(7, "A senha deve ter pelo menos 7 caracteres.")
    .max(100, "A senha deve ter no máximo 100 caracteres."),
});

export { authenticateUserSchema };
