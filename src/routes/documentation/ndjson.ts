import { z, type ZodTypeAny } from "zod";

/**
 * Listings that answer NDJSON, and how the document says so.
 *
 * `sendAsNDJSON` (config/stream-utils) streams `application/x-ndjson`: a
 * `{"meta": …}` line, then one line per item. The stream never goes through
 * the serializer, so the zod schema a route declares for its 200 is never
 * applied — and it was being used to describe shapes that are never sent: 26
 * routes published `{ data: [...], total }`, 18 a `{ description }`
 * placeholder, and every one of them as `application/json`. A client
 * generated from that calls `JSON.parse` on the whole body and fails on the
 * second line, or reads `data` and finds nothing.
 *
 * The helpers below return a fresh `z.any()` for the route's 200 — the
 * runtime value it always effectively had — and register next to it what the
 * lines really are, which the OpenAPI transform renders as
 * `application/x-ndjson`. Documentation only; the wire is unchanged.
 */
interface NdjsonDoc {
  item: ZodTypeAny;
  meta: ZodTypeAny;
  cursor: boolean;
}

const NDJSON_DOCS = new WeakMap<object, NdjsonDoc>();

const count = z
  .number()
  .int()
  .describe("Total de registros do filtro, para desenhar o paginador.");

/** The first line of an offset listing (`page`/`pageSize`). */
const offsetMeta = z.object({
  total: count.optional(),
  page: z.number().int().optional().describe("A página pedida."),
  pageSize: z.number().int().optional().describe("O tamanho de página aplicado."),
  searchMeta: z
    .record(z.unknown())
    .optional()
    .describe("Extras que algumas listagens anexam (contadores, filtros)."),
});

/** An offset listing whose `searchMeta` has a known shape. */
function offsetMetaWith(searchMeta: ZodTypeAny) {
  return offsetMeta.extend({ searchMeta });
}

const cursorPage = z.object({
  nextCursor: z
    .string()
    .nullable()
    .describe(
      "Passe como `cursor` para buscar a próxima página; null quando não há mais.",
    ),
  hasMore: z.boolean().describe("true enquanto houver próxima página."),
});

/**
 * `total: 0` is really sent — the cursor controllers hand the stream a zero,
 * because counting the whole set on every "load more" would cost more than the
 * page. Documented rather than removed: the web's NDJSON reader receives it.
 */
const zeroTotal = z
  .literal(0)
  .optional()
  .describe("Sempre 0 nas listas por cursor (não contamos o conjunto); não use.");

/**
 * The first line of a cursor listing, with whatever extras it carries.
 * `total: null` is a feed that sends no total at all.
 */
function cursorMeta(
  extra: z.ZodRawShape = {},
  total: ZodTypeAny | null = zeroTotal,
) {
  const searchMeta = cursorPage.extend(extra);

  return total ? z.object({ total, searchMeta }) : z.object({ searchMeta });
}

function register(item: ZodTypeAny, meta: ZodTypeAny, cursor: boolean): ZodTypeAny {
  const runtime = z.any();

  NDJSON_DOCS.set(runtime, { item, meta, cursor });

  return runtime;
}

/** An offset listing whose items are `item`. */
function ndjsonList(item: ZodTypeAny, meta: ZodTypeAny = offsetMeta): ZodTypeAny {
  return register(item, meta, false);
}

/** A cursor listing: `meta.searchMeta.{nextCursor, hasMore}`. */
function ndjsonCursor(item: ZodTypeAny, meta: ZodTypeAny = cursorMeta()): ZodTypeAny {
  return register(item, meta, true);
}

/**
 * The item of a legacy `{ data: z.array(item), total }` list document.
 *
 * Those documents described an envelope the stream never sends, but their
 * item schemas were written from the repository selects and are reused as
 * they are. Throws at boot on anything else, so a wrong call cannot quietly
 * publish an empty item.
 */
function itemOf(list: z.AnyZodObject): z.AnyZodObject {
  const data = list.shape.data;

  if (!(data instanceof z.ZodArray) || !(data.element instanceof z.ZodObject)) {
    throw new Error("itemOf espera um schema { data: z.array(z.object(...)) }");
  }

  return data.element as z.AnyZodObject;
}

function ndjsonDocFor(schema: unknown): NdjsonDoc | undefined {
  return schema && typeof schema === "object"
    ? NDJSON_DOCS.get(schema)
    : undefined;
}

export {
  cursorMeta,
  itemOf,
  ndjsonCursor,
  ndjsonDocFor,
  ndjsonList,
  offsetMeta,
  offsetMetaWith,
  type NdjsonDoc,
};
