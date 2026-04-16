import { z } from "zod";

const updateDeletePermissionSchema = z.object({
  permissionId: z
    .string({ required_error: "ID da permissão é obrigatório!" })
    .uuid("ID da permissão é inválido."),
});

export { updateDeletePermissionSchema };
