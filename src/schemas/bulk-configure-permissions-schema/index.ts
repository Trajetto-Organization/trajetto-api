import { z } from "zod";
import { EnumPermissionKey } from "@/config/permissions";

const bulkConfigurePermissionsSchema = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatória!" })
    .uuid("ID da empresa é inválida."),
  profileAccessId: z
    .string({ required_error: "ID do perfil de acesso é obrigatório!" })
    .uuid("ID do Perfil de acesso é inválido."),
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
