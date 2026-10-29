import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { sortFields } from "@/shared/pagination/list-query";

import {
  PROFILE_SORT_FALLBACK,
  PROFILE_SORT_KEYS,
} from "@/modules/profile-access/usecases/list-profile-access/profile-access-list";

/**
 * GET /profile-access/list-profile-access, mirrored by the web
 * (src/features/profile-access/server-table.ts): sort and order against the
 * columns the database can order by (decision 8.8).
 */
const listProfileAccessSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia (e é obrigatório para ele): escolhe a empresa. Os demais listam sempre a própria.",
    ),
  ...sortFields(PROFILE_SORT_KEYS, PROFILE_SORT_FALLBACK),
});

export { listProfileAccessSchema };
