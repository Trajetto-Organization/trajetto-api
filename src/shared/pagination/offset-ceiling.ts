import type { FastifyRequest } from "fastify";

import { env } from "@/env";
import { AppError } from "@/shared/errors/AppError";

/**
 * How deep an offset listing may page (plano-escala F2-30, decision D42).
 *
 * Every panel listing pages with OFFSET: page 5,000 of the deliveries makes
 * Postgres read, sort and throw away 49,990 rows to hand back ten, and the
 * counts of the screen were already paid on page 1. Nobody reads row 50,000
 * of a list by turning pages; they filter (the period, a status, a search)
 * or export. So past LIST_MAX_OFFSET rows (10,000) the listing answers 400
 * LIST_OFFSET_TOO_DEEP, with a sentence that says what to do instead, and
 * the web stops its pager at the same row.
 *
 * Checked once for every route, after the querystring is validated: an
 * offset listing is a route whose `page` and `pageSize` came out of
 * validation as numbers (shared/pagination/page-size.ts). The public API
 * pages by cursor and never meets it. `LIST_MAX_OFFSET=0` turns it off.
 * A route with `config.ownOffsetCeiling` caps its own pages and answers
 * its own code, which clients already know (the webhook monitor).
 */

const LIST_OFFSET_TOO_DEEP = "LIST_OFFSET_TOO_DEEP";

/** 10000 → "10.000", whatever the process's ICU data. */
function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function listOffsetTooDeep(maxOffset: number): AppError {
  return new AppError(
    `A lista vai até a linha ${thousands(maxOffset)}. Para ver além, use um filtro (o período, o status ou a busca) ou a exportação.`,
    400,
    LIST_OFFSET_TOO_DEEP,
  );
}

/** Whether this page starts at or past the ceiling; 0 has none. */
function isTooDeep(page: number, pageSize: number, maxOffset: number): boolean {
  return maxOffset > 0 && (page - 1) * pageSize >= maxOffset;
}

/** The global preHandler of src/http.ts. */
async function rejectDeepListOffset(request: FastifyRequest): Promise<void> {
  const query = request.query as
    { page?: unknown; pageSize?: unknown } | null | undefined;

  if (typeof query?.page !== "number" || typeof query.pageSize !== "number") {
    return;
  }

  if (request.routeOptions.config?.ownOffsetCeiling) return;

  if (isTooDeep(query.page, query.pageSize, env.LIST_MAX_OFFSET)) {
    throw listOffsetTooDeep(env.LIST_MAX_OFFSET);
  }
}

export {
  LIST_OFFSET_TOO_DEEP,
  isTooDeep,
  listOffsetTooDeep,
  rejectDeepListOffset,
};
