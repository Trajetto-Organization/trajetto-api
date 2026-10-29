import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";

import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  PERMISSION_FLAG_VALUES,
  PERMISSION_KEYS,
  PERMISSION_SORT_FALLBACK,
  PERMISSION_SORT_KEYS,
} from "@/modules/permission/usecases/list-permission/permission-list";

/**
 * GET /permission/list-permission, mirrored by the web
 * (src/features/permission/server-table.ts): one param per facet, sort and
 * order against the columns the database can order by (decision 8.8).
 */
const listPermissionSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia (e é obrigatório para ele): escolhe a empresa. Os demais listam sempre a própria.",
    ),
  ...sortFields(PERMISSION_SORT_KEYS, PERMISSION_SORT_FALLBACK),
  permissionKey: facetField(PERMISSION_KEYS, "Recurso da permissão."),
  profileAccessId: idFacetField("Perfis de acesso."),
  read: facetField(PERMISSION_FLAG_VALUES, "Leitura: enabled ou disabled."),
  write: facetField(PERMISSION_FLAG_VALUES, "Escrita: enabled ou disabled."),
});

export { listPermissionSchema };
