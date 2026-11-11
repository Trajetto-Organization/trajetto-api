import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeletePermissionSchema = z.object({
  permissionId: z
    .string(fieldError({ required: "ID da permissão é obrigatório!" }))
    .uuid("ID da permissão é inválido."),
});

export { updateDeletePermissionSchema };
