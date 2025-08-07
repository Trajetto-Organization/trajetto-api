import { z } from "zod";

const updateDeletePermissionSchema = z.object({
  permissionId: z.string().min(1, "O ID da permissão é obrigatória!"),
});

export { updateDeletePermissionSchema };
