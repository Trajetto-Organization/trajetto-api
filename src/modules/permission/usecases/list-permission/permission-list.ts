import type { Prisma } from "@prisma/client";

import { permissionLabels, type PermissionKey } from "@/config/permissions";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortSpec } from "@/shared/pagination/list-query";

/**
 * The permission list's server-side table (decision 8.8). Every facet is a
 * column of the permission row, so one GROUP BY yields the pager total and
 * each filter's options with their counts; the old web filters narrowed only
 * the ten rows on screen.
 */

const PERMISSION_KEYS = Object.keys(permissionLabels) as [
  PermissionKey,
  ...PermissionKey[],
];

const PERMISSION_FLAG_VALUES = ["enabled", "disabled"] as const;

type PermissionFlag = (typeof PERMISSION_FLAG_VALUES)[number];

/** Same ids as the web table's columns, so the URL value is the column id. */
const PERMISSION_SORT_KEYS = [
  "created_at",
  "updated_at",
  "action",
  "permissionKey",
  "profile_name",
  "canRead",
  "canWrite",
] as const;

type PermissionSortKey = (typeof PERMISSION_SORT_KEYS)[number];

const PERMISSION_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.PermissionOrderByWithRelationInput;

const PERMISSION_SORT: SortSpec<PermissionSortKey, OrderBy> = {
  keys: PERMISSION_SORT_KEYS,
  fallback: PERMISSION_SORT_FALLBACK,
  columns: {
    created_at: (order) => ({ created_at: order }),
    updated_at: (order) => ({ updated_at: order }),
    action: (order) => ({ action: order }),
    permissionKey: (order) => ({ permissionKey: order }),
    profile_name: (order) => ({ profileAccess: { name: order } }),
    canRead: (order) => ({ canRead: order }),
    canWrite: (order) => ({ canWrite: order }),
  },
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface PermissionListFilters {
  businessId: string;
  search?: string;
  /** A BUSINESS_USER never sees (nor edits) the permissions of their own profile. */
  hideProfileId?: string | null;
  permissionKeys?: PermissionKey[];
  profileAccessIds?: string[];
  read?: PermissionFlag[];
  write?: PermissionFlag[];
}

type PermissionFacet = "permissionKey" | "profileAccessId" | "read" | "write";

const FACETS: readonly PermissionFacet[] = [
  "permissionKey",
  "profileAccessId",
  "read",
  "write",
];

/** Keys whose Portuguese label contains the term ("frota" → none, "entregas" → delivery). */
function keysLabelled(term: string): PermissionKey[] {
  const lower = term.toLocaleLowerCase("pt-BR");

  return PERMISSION_KEYS.filter((key) =>
    permissionLabels[key].toLocaleLowerCase("pt-BR").includes(lower),
  );
}

function permissionListWhere(
  filters: PermissionListFilters,
  { withFacets }: { withFacets: boolean },
): Prisma.PermissionWhereInput {
  const and: Prisma.PermissionWhereInput[] = [];

  if (withFacets) {
    if (filters.permissionKeys?.length) {
      and.push({ permissionKey: { in: filters.permissionKeys } });
    }

    if (filters.profileAccessIds?.length) {
      and.push({ profileAccessId: { in: filters.profileAccessIds } });
    }

    if (filters.read?.length === 1) {
      and.push({ canRead: filters.read[0] === "enabled" });
    }

    if (filters.write?.length === 1) {
      and.push({ canWrite: filters.write[0] === "enabled" });
    }
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    const keys = keysLabelled(term);

    and.push(
      buildSearchOr<Prisma.PermissionWhereInput>([
        { id: { contains: term, mode: "insensitive" as const } },
        { action: { contains: term, mode: "insensitive" as const } },
        { profileAccess: { name: { contains: term, mode: "insensitive" as const } } },
        ...(keys.length > 0 ? [{ permissionKey: { in: keys } }] : []),
      ]),
    );
  }

  return {
    // Tenant first: no facet or term widens past the company.
    businessId: filters.businessId,
    ...(filters.hideProfileId && { profileAccessId: { not: filters.hideProfileId } }),
    ...(and.length > 0 && { AND: and }),
  };
}

interface PermissionGroupCount {
  permissionKey: string;
  profileAccessId: string;
  canRead: boolean;
  canWrite: boolean;
  count: number;
}

interface PermissionListSearchMeta {
  /** Every filter but write, so Com escrita + Só leitura = Total. */
  total: number;
  writable: number;
  readOnly: number;
  facets: {
    permissionKey: FacetCount[];
    profileAccessId: FacetCount[];
    read: FacetCount[];
    write: FacetCount[];
  };
}

function valueOf(group: PermissionGroupCount, facet: PermissionFacet): string {
  switch (facet) {
    case "permissionKey":
      return group.permissionKey;
    case "profileAccessId":
      return group.profileAccessId;
    case "read":
      return group.canRead ? "enabled" : "disabled";
    case "write":
      return group.canWrite ? "enabled" : "disabled";
  }
}

function selectedOf(
  filters: PermissionListFilters,
  facet: PermissionFacet,
): readonly string[] | undefined {
  const selected = {
    permissionKey: filters.permissionKeys,
    profileAccessId: filters.profileAccessIds,
    read: filters.read,
    write: filters.write,
  }[facet];

  return selected && selected.length > 0 ? selected : undefined;
}

/** Pager total, cards and filter options; disjunctive like every list. */
function summarizePermissionList(
  groups: PermissionGroupCount[],
  filters: PermissionListFilters,
  profileNames: ReadonlyMap<string, string> = new Map(),
): { total: number; searchMeta: PermissionListSearchMeta } {
  const keeps = (group: PermissionGroupCount, except?: PermissionFacet) =>
    FACETS.every((facet) => {
      if (facet === except) return true;

      const selected = selectedOf(filters, facet);

      return !selected || selected.includes(valueOf(group, facet));
    });

  const countBy = (facet: PermissionFacet): Map<string, number> => {
    const counts = new Map<string, number>();

    for (const group of groups) {
      if (!keeps(group, facet)) continue;

      const value = valueOf(group, facet);
      counts.set(value, (counts.get(value) ?? 0) + group.count);
    }

    return counts;
  };

  const closedSet = (facet: PermissionFacet, values: readonly string[]) => {
    const counts = countBy(facet);

    return values.map((value) => ({ value, count: counts.get(value) ?? 0 }));
  };

  const profileCounts = countBy("profileAccessId");
  const profileOptions: FacetCount[] = [
    ...new Set([
      ...groups.map((group) => group.profileAccessId),
      ...(filters.profileAccessIds ?? []),
    ]),
  ]
    .filter((id) => profileNames.has(id))
    .map((id) => ({
      value: id,
      label: profileNames.get(id),
      count: profileCounts.get(id) ?? 0,
    }))
    .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "", "pt-BR"));

  const writeCounts = countBy("write");
  const writable = writeCounts.get("enabled") ?? 0;
  const readOnly = writeCounts.get("disabled") ?? 0;

  return {
    total: groups
      .filter((group) => keeps(group))
      .reduce((sum, group) => sum + group.count, 0),
    searchMeta: {
      total: writable + readOnly,
      writable,
      readOnly,
      facets: {
        permissionKey: closedSet("permissionKey", PERMISSION_KEYS),
        profileAccessId: profileOptions,
        read: closedSet("read", PERMISSION_FLAG_VALUES),
        write: closedSet("write", PERMISSION_FLAG_VALUES),
      },
    },
  };
}

export {
  PERMISSION_FLAG_VALUES,
  PERMISSION_KEYS,
  PERMISSION_SORT,
  PERMISSION_SORT_FALLBACK,
  PERMISSION_SORT_KEYS,
  keysLabelled,
  permissionListWhere,
  summarizePermissionList,
  type PermissionFlag,
  type PermissionGroupCount,
  type PermissionListFilters,
  type PermissionListSearchMeta,
  type PermissionSortKey,
};
