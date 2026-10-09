import { z } from "zod";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { facetField, sortFields } from "@/shared/pagination/list-query";
import { ACTIVE_STATUSES, YES_NO } from "@/shared/delivery/catalog-list";
import { OCCURRENCE_CATEGORIES } from "@/modules/occurrence-type/rules/occurrence-category-rules";

import {
  OCCURRENCE_TYPE_SORT_FALLBACK,
  OCCURRENCE_TYPE_SORT_KEYS,
} from "@/modules/occurrence-type/usecases/list-occurrence-type/occurrence-type-list";

const listOccurrenceTypeSchema = listPagesSchema.extend({
  businessId: z
    .string()
    .uuid("ID da empresa é inválido.")
    .optional()
    .describe(
      "Só o MASTER envia: escolhe a empresa. Ausente, a empresa do usuário autenticado é usada.",
    ),
  ...sortFields(OCCURRENCE_TYPE_SORT_KEYS, OCCURRENCE_TYPE_SORT_FALLBACK),
  status: facetField(ACTIVE_STATUSES, "Status do tipo (active = ativo)."),
  blocking: facetField(YES_NO, "Impeditiva: yes = marca a entrega como insucesso."),
  photo: facetField(YES_NO, "Foto: yes = exige foto do motorista."),
  category: facetField(
    OCCURRENCE_CATEGORIES,
    "Categoria (decisão 14.3): DELIVERED (entrega), NOT_DELIVERED (não entrega), PAUSE (pausa).",
  ),
});

export { listOccurrenceTypeSchema };
