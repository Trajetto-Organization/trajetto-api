import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { facetField, sortFields } from "@/shared/pagination/list-query";

import {
  ACTIVITY_ACTIONS,
  ACTIVITY_ACTOR_ROLES,
  ACTIVITY_STATUS_VALUES,
  ACTIVITY_TYPE_VALUES,
} from "@/modules/activity/activity-catalog";

/**
 * The activity table's querystring (decision 8.8): the facets filter the
 * whole trail on the server, not the ten rows of a page (FLEET-ACT-3). Only
 * `created_at` orders: it is the column the indexes serve.
 */
const listActivitiesSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: recorta a tabela para uma empresa. Ausente, o MASTER vê todas; os demais, sempre a própria.",
    ),
  ...sortFields(["created_at"] as const, { sort: "created_at", order: "desc" }),
  status: facetField(
    ACTIVITY_STATUS_VALUES,
    'Status registrado. Cada valor também encontra as grafias antigas ("Em Rota", "PLANNED"…).',
  ),
  type: facetField(ACTIVITY_TYPE_VALUES, "Tipo do registro (a entidade)."),
  action: facetField(ACTIVITY_ACTIONS, "Ação: create, update ou delete."),
  role: facetField(
    ACTIVITY_ACTOR_ROLES,
    "Papel de quem agiu, como o leitor o vê: DRIVER é o motorista pelo aplicativo; PLATFORM, a equipe Trajetto.",
  ),
});

export { listActivitiesSchema };
