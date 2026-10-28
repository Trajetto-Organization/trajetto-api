import { escapeLikePattern } from "@/shared/utils/like-pattern";

/**
 * A list search that finds a record by the id its table shows.
 *
 * Every table of the web shows the record id compact — the last twelve
 * characters of the UUID (`279d9fb8f0bd`, web IdCell) — and its row menu
 * copies the full one ("Copiar ID"). Either must find the row when pasted
 * into the search. Most lists already matched `id contains term`; Rotas did
 * not match the id at all, and Veículos, Tipos de veículo and Checklists
 * matched only an exact full UUID, case-sensitively, so the compact id and an
 * upper-case paste found nothing.
 *
 * Only a term SHAPED like an id becomes a condition, so a name or a plate
 * never adds one:
 *   - a full UUID (any case): equality on the lowercased value, the key's
 *     own index — Postgres stores and Prisma mints ids in lower case;
 *   - the tail of a UUID, at least MIN_TAIL_LENGTH characters with its
 *     dashes where a UUID has them (`279d9fb8f0bd`, `9def-279d9fb8f0bd`):
 *     `endsWith`, case-insensitive. Shorter hex ("2024", "abc") would match
 *     ids by chance and is not read as one.
 *
 * Tenant scope is untouched: the conditions join the search's OR, and the
 * caller keeps `businessId` a top-level key of its `where`, so a tail shared
 * with another company's record never reaches across. Spread the result into
 * buildSearchOr (an ARRAY, empty when the term is not an id).
 */
const UUID_TEMPLATE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";

/** The fewest characters of a tail read as an id (eight hex digits). */
const MIN_TAIL_LENGTH = 8;

const HEX = /^[0-9a-f]$/;

type IdSearch = { kind: "exact"; id: string } | { kind: "tail"; tail: string };

/** Whether `value` (lower case) matches the end of the UUID template. */
function isUuidSuffix(value: string): boolean {
  const template = UUID_TEMPLATE.slice(-value.length);

  if (template.length !== value.length) return false;

  for (let index = 0; index < value.length; index += 1) {
    const expected = template[index];
    const actual = value[index];

    if (expected === "-" ? actual !== "-" : !HEX.test(actual)) return false;
  }

  return true;
}

/** How a search term reads as a record id, or null when it does not. */
function idSearchOf(term: string): IdSearch | null {
  const value = term.trim().toLowerCase();

  if (!isUuidSuffix(value)) return null;

  if (value.length === UUID_TEMPLATE.length) {
    return { kind: "exact", id: value };
  }

  const hexDigits = value.replace(/-/g, "").length;

  return hexDigits >= MIN_TAIL_LENGTH ? { kind: "tail", tail: value } : null;
}

type IdCondition =
  | { id: string }
  | { id: { endsWith: string; mode: "insensitive" } };

/** The Prisma conditions on `id` a search term names (none, or one). */
function idSearchConditions(term: string): IdCondition[] {
  const search = idSearchOf(term);

  if (!search) return [];

  // The tail is hex digits and dashes only, so escaping changes nothing (and
  // buildSearchOr escaping it again is just as harmless). It is written here
  // so the LIKE stays literal even on a `where` built without buildSearchOr,
  // and so the guard in security/like-contains.test.ts sees it escaped.
  return search.kind === "exact"
    ? [{ id: search.id }]
    : [
        {
          id: {
            endsWith: escapeLikePattern(search.tail),
            mode: "insensitive",
          },
        },
      ];
}

/** The same reading over an in-memory row: the repositories' twins. */
function matchesIdSearch(id: string, term: string): boolean {
  const search = idSearchOf(term);

  if (!search) return false;

  // Equality is exact in Postgres; the tail compares without case (ILIKE).
  return search.kind === "exact"
    ? id === search.id
    : id.toLowerCase().endsWith(search.tail);
}

export {
  MIN_TAIL_LENGTH,
  idSearchConditions,
  idSearchOf,
  matchesIdSearch,
  type IdCondition,
  type IdSearch,
};
