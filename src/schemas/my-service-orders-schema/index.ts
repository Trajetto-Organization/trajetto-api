import { z } from "zod";

import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";

/**
 * "Minhas OS" (wave 3): the two sections of the driver's list, one cursor
 * each. No search: the app pages the sections as they are.
 */
const myServiceOrdersQuerySchema = cursorPaginationSchema
  .pick({ limit: true, cursor: true })
  .extend({
    scope: z
      .enum(["assigned", "vehicle"], {
        error: "Informe a seção: assigned ou vehicle.",
      })
      .describe(
        "assigned: as ordens em que você é o responsável. vehicle: as ordens dos veículos que você pode operar, menos as que já são suas.",
      ),
  });

export { myServiceOrdersQuerySchema };
