import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import {
  facetField,
  idFacetField,
  sortFields,
} from "@/shared/pagination/list-query";
import { DELIVERY_KINDS } from "@/shared/delivery/delivery-kind";

import {
  DELIVERY_LIST_STATUSES,
  DELIVERY_SORT_FALLBACK,
  DELIVERY_SORT_KEYS,
} from "@/modules/delivery/usecases/list-delivery/delivery-list";
import {
  MAX_CUSTOM_PERIOD_DAYS,
  refineDeliveryPeriod,
} from "@/modules/delivery/usecases/list-delivery/delivery-period";
import { listPeriodFields } from "@/shared/time/list-period";

/**
 * The deliveries listing's querystring (decision 8.8): the page, the search,
 * the server-side sort and one param per facet — the same params the export
 * takes, so the file is what the screen shows (decision 5.8).
 */
const deliveryListFilterFields = {
  status: facetField(DELIVERY_LIST_STATUSES, "Status da entrega."),
  shipperId: idFacetField("Embarcadores."),
  driverId: idFacetField("Motoristas."),
  kind: facetField(
    DELIVERY_KINDS,
    "Tipo: DELIVERY (entrega), SERVICE_ORDER (ordem de serviço) ou PICKUP (coleta, só pela planilha). Filtra sem contagem por opção.",
  ),
  // The meeting of 14/10/2026: the screen opens on today, with presets and a
  // custom range. Absent = every date (the API's answer before the period).
  // The fields and their rules are every listing's (shared/time/list-period).
  ...listPeriodFields(
    `Período pela data de criação, em dias civis no fuso da empresa: today (hoje), 7d, 14d ou 30d (os últimos N dias, hoje incluído) ou custom (com from e to, até ${MAX_CUSTOM_PERIOD_DAYS} dias). Ausente, todas as datas. Uma busca que é exatamente o ID, o pedido, a chave ou o número da NF de uma entrega ignora o período (o link de uma notificação acha a entrega antiga).`,
  ),
};

const listDeliverySchema = listPagesSchema
  .extend({
    businessId: z
      .string()
      .uuid("ID da empresa é inválido.")
      .optional()
      .describe(
        "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
      ),
    ...sortFields(DELIVERY_SORT_KEYS, DELIVERY_SORT_FALLBACK),
    ...deliveryListFilterFields,
    // plano-escala F2-30: list-only, the export does not take it.
    facets: z
      .enum(["skip"], { error: "facets aceita só o valor skip." })
      .optional()
      .describe(
        "`skip`: só a página, sem contar nada (sem `total`, sem os cartões e sem as opções dos filtros; `searchMeta.facetsSkipped` = true). Para quem vira a página com os mesmos filtros e já tem as contagens da página anterior. As linhas são as mesmas.",
      ),
  })
  .superRefine(refineDeliveryPeriod);

export { deliveryListFilterFields, listDeliverySchema };
