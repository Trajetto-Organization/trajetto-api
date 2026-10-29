import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";

import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";

import {
  MASTER_SORT_KEYS,
  USER_ACCESS_VALUES,
  USER_ROLE_VALUES,
  USER_SORT_FALLBACK,
  USER_SORT_KEYS,
  USER_TWO_FACTOR_VALUES,
} from "@/modules/user/usecases/list-users/user-list";

/**
 * GET /user/list-user, mirrored by the web (src/features/user/server-table.ts):
 * one param per facet, sort and order against the columns the database can
 * order by (decision 8.8).
 */
const listUserSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia (e é obrigatório para ele): escolhe a empresa. Os demais listam sempre a própria.",
    ),
  ...sortFields(USER_SORT_KEYS, USER_SORT_FALLBACK),
  role: facetField(USER_ROLE_VALUES, "Nível de acesso."),
  access: facetField(
    USER_ACCESS_VALUES,
    "Situação do acesso: active (liberado) ou revoked (revogado).",
  ),
  two_factor: facetField(
    USER_TWO_FACTOR_VALUES,
    "Verificação em duas etapas: enabled (habilitada) ou disabled.",
  ),
  profileAccessId: idFacetField("Perfis de acesso."),
});

/** GET /user/list-master-users: the same sort and the access/2FA facets. */
const listMasterUserSchema = listPagesSchema.extend({
  ...sortFields(MASTER_SORT_KEYS, USER_SORT_FALLBACK),
  access: facetField(
    USER_ACCESS_VALUES,
    "Situação do acesso: active (liberado) ou revoked (revogado).",
  ),
  two_factor: facetField(
    USER_TWO_FACTOR_VALUES,
    "Verificação em duas etapas: enabled (habilitada) ou disabled.",
  ),
});

export { listMasterUserSchema, listUserSchema };
