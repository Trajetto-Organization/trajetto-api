import { z } from "zod";
import { EnumPermissionKey } from "@/config/permissions";
import { fieldError } from "@/shared/validation/field-error";

/** One row per resource: there are no more rows than resources. */
const MAX_PERMISSION_ROWS = Object.values(EnumPermissionKey).length;

const bulkConfigurePermissionsSchema = z.object({
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatória!" }))
    .uuid("ID da empresa é inválida."),
  profileAccessId: z
    .string(fieldError({ required: "ID do perfil de acesso é obrigatório!" }))
    .uuid("ID do Perfil de acesso é inválido."),
  permissions: z
    .array(
      z
        .object({
          permissionKey: z.nativeEnum(EnumPermissionKey, {
            error: "Chave de permissão inválida.",
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
    // Before the refinement below: a longer list is refused before any row
    // is read.
    .max(MAX_PERMISSION_ROWS, "Há permissões demais nesta lista.")
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
