import { z } from "zod";
import { EnumPermissionKey } from "@/config/permissions";

const bulkConfigurePermissionsSchema = z.object({
  businessId: z.string().min(1, "A empresa é obrigatória!"),
  profileAccessId: z.string().min(1, "O Perfil de acesso é obrigatório!"),
  permissions: z.array(
    z.object({
      permissionKey: z.nativeEnum(EnumPermissionKey, {
        errorMap: () => ({ message: "Chave de permissão inválida." }),
      }),
      canRead: z.boolean(),
      canWrite: z.boolean().default(false),
    }),
  ),
});

export { bulkConfigurePermissionsSchema };
