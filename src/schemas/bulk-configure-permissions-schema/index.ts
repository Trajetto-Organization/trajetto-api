import { z } from "zod";
import { EnumPermissionKey } from "@/config/permissions";

const bulkConfigurePermissionsSchema = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatória!" })
    .uuid("ID da empresa é inválida."),
  profileAccessId: z
    .string({ required_error: "ID do perfil de acesso é obrigatório!" })
    .uuid("ID do Perfil de acesso é inválido."),
  permissions: z
    .array(
      z
        .object({
          permissionKey: z.nativeEnum(EnumPermissionKey, {
            errorMap: () => ({ message: "Chave de permissão inválida." }),
          }),
          canRead: z.boolean(),
          canWrite: z.boolean().default(false),
        })
        // As create and update: a row without read grants nothing (the gate
        // reads it as no access), so it is refused instead of stored
        // (ROUTE-KEY-1).
        .refine((item) => item.canRead, {
          message:
            "Selecione a opção Leitura (caso deseje, marque também Escrita).",
          path: ["canRead"],
        }),
    )
    // One row per resource: a repeated key hit the table's unique index
    // inside createMany and came back as a 500.
    .superRefine((items, ctx) => {
      const seen = new Set<string>();

      items.forEach((item, index) => {
        if (seen.has(item.permissionKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Cada recurso pode aparecer uma única vez na configuração.",
            path: [index, "permissionKey"],
          });
        }

        seen.add(item.permissionKey);
      });
    }),
});

export { bulkConfigurePermissionsSchema };
