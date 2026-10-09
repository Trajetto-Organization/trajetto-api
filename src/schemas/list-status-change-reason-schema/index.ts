import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { facetField, sortFields } from "@/shared/pagination/list-query";
import { ACTIVE_STATUSES } from "@/shared/delivery/catalog-list";

import {
  STATUS_REASON_SORT_FALLBACK,
  STATUS_REASON_SORT_KEYS,
} from "@/modules/status-change-reason/usecases/list-status-change-reason/status-change-reason-list";

const listStatusChangeReasonSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(STATUS_REASON_SORT_KEYS, STATUS_REASON_SORT_FALLBACK),
  status: facetField(ACTIVE_STATUSES, "Status do motivo (active = ativo)."),
});

export { listStatusChangeReasonSchema };
