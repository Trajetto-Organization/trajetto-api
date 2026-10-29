import type { FacetCount } from "@/shared/pagination/list-meta";

/**
 * The Entregas catalog tabs on the server (decision 8.8): embarcadores, tipos
 * de ocorrência, motivos de status and importações.
 *
 * Their filters are closed sets over a few columns (ativo, impeditiva, foto,
 * status, origem). One GROUP BY over every filtered column, with the search
 * applied and no facet, is enough to answer the pager total, the cards and
 * every filter's counts by the disjunctive rule — without a second scan and
 * within the two-connection budget of a screen.
 */

/** One row of that GROUP BY: the value of each filtered column, and how many. */
interface DimensionGroup<F extends string> {
  values: Record<F, string>;
  count: number;
}

type FacetSelection<F extends string> = Partial<
  Record<F, readonly string[] | undefined>
>;

/** Whether a group survives every selected facet, optionally but one. */
function keptBy<F extends string>(
  group: DimensionGroup<F>,
  selection: FacetSelection<F>,
  except?: F,
): boolean {
  return (Object.keys(selection) as F[]).every((facet) => {
    if (facet === except) return true;

    const chosen = selection[facet];

    return !chosen?.length || chosen.includes(group.values[facet]);
  });
}

/**
 * The pager total (every facet applied) and each facet's options, counted
 * with every OTHER facet applied, never its own: choosing "Inativo" narrows
 * the table while the "Ativo" option still says how many it would bring.
 * Every value of the domain is listed, 0 included.
 */
function disjunctiveFacets<F extends string>(
  groups: ReadonlyArray<DimensionGroup<F>>,
  selection: FacetSelection<F>,
  domains: Record<F, readonly string[]>,
): { total: number; facets: Record<F, FacetCount[]> } {
  const total = groups
    .filter((group) => keptBy(group, selection))
    .reduce((sum, group) => sum + group.count, 0);

  const facets = Object.fromEntries(
    (Object.keys(domains) as F[]).map((facet) => {
      const base = groups.filter((group) => keptBy(group, selection, facet));

      return [
        facet,
        domains[facet].map((value) => ({
          value,
          count: base
            .filter((group) => group.values[facet] === value)
            .reduce((sum, group) => sum + group.count, 0),
        })),
      ];
    }),
  ) as Record<F, FacetCount[]>;

  return { total, facets };
}

/** The count a facet option brings, from `disjunctiveFacets`' output. */
function facetCount(options: readonly FacetCount[], value: string): number {
  return options.find((option) => option.value === value)?.count ?? 0;
}

/** "active"/"inactive", the wire values of the Status filter. */
const ACTIVE_STATUSES = ["active", "inactive"] as const;

type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

function activeStatusOf(isActive: boolean | null | undefined): ActiveStatus {
  // NULL never reaches here (NOT NULL DEFAULT true); a twin row without the
  // field is the default, active.
  return isActive === false ? "inactive" : "active";
}

/**
 * The `is_active` condition a Status selection means, or undefined when it
 * keeps everything (none or both chosen).
 */
function isActiveFilter(
  statuses: readonly ActiveStatus[] | undefined,
): boolean | undefined {
  if (!statuses?.length || statuses.length === ACTIVE_STATUSES.length) {
    return undefined;
  }

  return statuses[0] === "active";
}

/** "yes"/"no", the wire values of a yes-or-no filter (Impeditiva, Foto). */
const YES_NO = ["yes", "no"] as const;

type YesNo = (typeof YES_NO)[number];

function yesNoOf(value: boolean | null | undefined): YesNo {
  return value === true ? "yes" : "no";
}

function yesNoFilter(
  values: readonly YesNo[] | undefined,
): boolean | undefined {
  if (!values?.length || values.length === YES_NO.length) return undefined;

  return values[0] === "yes";
}

export {
  ACTIVE_STATUSES,
  YES_NO,
  activeStatusOf,
  disjunctiveFacets,
  facetCount,
  isActiveFilter,
  keptBy,
  yesNoFilter,
  yesNoOf,
  type ActiveStatus,
  type DimensionGroup,
  type FacetSelection,
  type YesNo,
};
