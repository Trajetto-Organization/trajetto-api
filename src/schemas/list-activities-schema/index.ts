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
 * The table's periods (plano-escala F2-19, decision D42), in days. Absent:
 * the whole trail, as the web before the period sent it.
 */
const ACTIVITY_TABLE_PERIODS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
} as const;

type ActivityTablePeriod = keyof typeof ACTIVITY_TABLE_PERIODS;

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
  period: z
    .enum(
      Object.keys(ACTIVITY_TABLE_PERIODS) as [
        ActivityTablePeriod,
        ...ActivityTablePeriod[],
      ],
    )
    .optional()
    .describe(
      "Janela da tabela em dias civis no fuso da empresa, hoje incluído: 7d, 30d, 90d ou 365d. Ausente, o registro inteiro (a web de antes do período). A web manda 30d por padrão: com o registro particionado por mês, o período lê um ou dois meses em vez de todos.",
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

export {
  ACTIVITY_TABLE_PERIODS,
  listActivitiesSchema,
  type ActivityTablePeriod,
};
