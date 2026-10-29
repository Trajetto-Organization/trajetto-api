import { z } from "zod";

/**
 * The cards of a company catalog (perfis de acesso, tipos de veículo, tipos
 * de combustível): how many entries the search finds, how much points at
 * them, how many nothing points at, and the entry most used.
 *
 * A catalog is small per company (a handful to a few dozen rows), so the
 * repository reads one count per entry for the whole search — not just the
 * page — and this folds them. Counting over the page on screen would be the
 * mistake decision 8.8 forbids.
 */

/** One catalog entry of the search and how many records point at it. */
interface CatalogUsage {
  id: string;
  label: string;
  count: number;
}

/** The entry most records point at; null when nothing points at any. */
interface CatalogLeader {
  id: string;
  label: string;
  count: number;
}

interface CatalogUsageSummary {
  /** Entries the search finds: the pager's total. */
  total: number;
  /** Records pointing at those entries (the sum of the table's column). */
  linked: number;
  /** Entries nothing points at: the ones that could be deleted. */
  unused: number;
  leader: CatalogLeader | null;
}

const collator = new Intl.Collator("pt-BR", { sensitivity: "base" });

/**
 * Ties go to the label in pt-BR order, then the id: the same numbers must
 * name the same entry on every request, or the card flickers on Revalidar.
 */
function compareLeaders(a: CatalogUsage, b: CatalogUsage): number {
  return (
    b.count - a.count ||
    collator.compare(a.label, b.label) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function pickLeader(usage: ReadonlyArray<CatalogUsage>): CatalogLeader | null {
  const leader = usage
    .filter((entry) => entry.count > 0)
    .sort(compareLeaders)[0];

  return leader
    ? { id: leader.id, label: leader.label, count: leader.count }
    : null;
}

function summarizeCatalogUsage(
  usage: ReadonlyArray<CatalogUsage>,
): CatalogUsageSummary {
  return {
    total: usage.length,
    linked: usage.reduce((sum, entry) => sum + entry.count, 0),
    unused: usage.filter((entry) => entry.count === 0).length,
    leader: pickLeader(usage),
  };
}

/** Documents a leader card (`mostUsed`, `mostRefueled`…): documentation only. */
function catalogLeaderDoc(countDescription: string) {
  return z
    .object({
      id: z.string().describe("O ID do cadastro."),
      label: z.string().describe("O nome do cadastro."),
      count: z.number().int().describe(countDescription),
    })
    .nullable();
}

export {
  catalogLeaderDoc,
  pickLeader,
  summarizeCatalogUsage,
  type CatalogLeader,
  type CatalogUsage,
  type CatalogUsageSummary,
};
