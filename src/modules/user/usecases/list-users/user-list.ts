import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder, SortSpec } from "@/shared/pagination/list-query";

import type { UserRole } from "../../dtos/user-dto";

/**
 * The user list's server-side table (decision 8.8): what it sorts by, what
 * it filters by and how the cards and filter counts are derived. The cards
 * used to count "ativos", "2FA" and "e-mail verificado" among the ten rows on
 * screen and set them beside the company's total.
 */

/** Roles a listing may show, by who asks: never MASTERs, never above you. */
const LISTED_ROLES: Record<UserRole, readonly UserRole[]> = {
  MASTER: ["BUSINESS_USER", "BUSINESS_ADMIN"],
  BUSINESS_ADMIN: ["BUSINESS_ADMIN", "BUSINESS_USER"],
  BUSINESS_USER: ["BUSINESS_USER"],
};

const USER_ROLE_VALUES = ["BUSINESS_ADMIN", "BUSINESS_USER"] as const;
const USER_ACCESS_VALUES = ["active", "revoked"] as const;
const USER_TWO_FACTOR_VALUES = ["enabled", "disabled"] as const;

type ListedRole = (typeof USER_ROLE_VALUES)[number];
type UserAccess = (typeof USER_ACCESS_VALUES)[number];
type UserTwoFactor = (typeof USER_TWO_FACTOR_VALUES)[number];

/** Same ids as the web table's columns, so the URL value is the column id. */
const USER_SORT_KEYS = [
  "created_at",
  "updated_at",
  "name",
  "email",
  "role",
  "email_verified",
  "profileAccess",
  "driverName",
] as const;

type UserSortKey = (typeof USER_SORT_KEYS)[number];

/** A master has no profile nor driver: those columns order nothing there. */
const MASTER_SORT_KEYS = [
  "created_at",
  "updated_at",
  "name",
  "email",
  "email_verified",
] as const satisfies readonly UserSortKey[];

type MasterSortKey = (typeof MASTER_SORT_KEYS)[number];

const USER_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.UserOrderByWithRelationInput;

const USER_SORT: SortSpec<UserSortKey, OrderBy> = {
  keys: USER_SORT_KEYS,
  fallback: USER_SORT_FALLBACK,
  columns: {
    created_at: (order) => ({ created_at: order }),
    updated_at: (order) => ({ updated_at: order }),
    name: (order) => ({ name: order }),
    email: (order) => ({ email: order }),
    role: (order) => ({ role: order }),
    // Unverified addresses stay at the end in both directions.
    email_verified: (order) => ({
      email_verified: { sort: order, nulls: "last" },
    }),
    profileAccess: (order) => ({ profileAccess: { name: order } }),
    driverName: (order) => ({ driver: { name: order } }),
  },
  // Newest first inside a tie; the id breaks what created_at cannot.
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface UserListFilters {
  /** Who asks: decides the roles listed; never listed themselves. */
  currentUserId: string;
  currentUserRole: UserRole;
  businessId: string;
  search?: string;
  roles?: ListedRole[];
  access?: UserAccess[];
  twoFactor?: UserTwoFactor[];
  profileAccessIds?: string[];
}

type UserFacet = "role" | "access" | "two_factor" | "profileAccessId";

const FACETS: readonly UserFacet[] = [
  "role",
  "access",
  "two_factor",
  "profileAccessId",
];

/** Role words a person types, to the role they mean ("admin" finds admins). */
const ROLE_WORDS: ReadonlyArray<[string, ListedRole]> = [
  ["administrador", "BUSINESS_ADMIN"],
  ["usuário", "BUSINESS_USER"],
  ["usuario", "BUSINESS_USER"],
];

function rolesNamedBy(term: string): ListedRole[] {
  const lower = term.toLocaleLowerCase("pt-BR");

  return Array.from(
    new Set(
      ROLE_WORDS.filter(([word]) => word.includes(lower)).map(([, role]) => role),
    ),
  );
}

/**
 * The fields a typed term is compared with, as one escaped OR (buildSearchOr
 * makes `%` and `_` literal). Null without a term.
 */
function userSearchWhere(
  search: string | undefined,
): Prisma.UserWhereInput | null {
  const term = search?.trim() ?? "";

  if (!term) return null;

  const roles = rolesNamedBy(term);

  return buildSearchOr<Prisma.UserWhereInput>([
    { id: { contains: term, mode: "insensitive" as const } },
    { name: { contains: term, mode: "insensitive" as const } },
    { email: { contains: term, mode: "insensitive" as const } },
    { profileAccess: { name: { contains: term, mode: "insensitive" as const } } },
    { driver: { name: { contains: term, mode: "insensitive" as const } } },
    ...(roles.length > 0 ? [{ role: { in: roles } }] : []),
  ]);
}

/**
 * The list's `where`. `withFacets: false` is the base the counts are grouped
 * over: every facet is a column of the user row, so one GROUP BY over the
 * base yields the pager total, the cards and each filter's options.
 */
function userListWhere(
  filters: UserListFilters,
  { withFacets }: { withFacets: boolean },
): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];

  if (withFacets) {
    if (filters.roles?.length) and.push({ role: { in: filters.roles } });

    if (filters.access?.length === 1) {
      and.push({ access_revoked: filters.access[0] === "revoked" });
    }

    if (filters.twoFactor?.length === 1) {
      and.push({ two_factor_enabled: filters.twoFactor[0] === "enabled" });
    }

    if (filters.profileAccessIds?.length) {
      and.push({ profileAccessId: { in: filters.profileAccessIds } });
    }
  }

  const search = userSearchWhere(filters.search);

  if (search) and.push(search);

  // The tenant stays a top-level key: the (businessId, created_at) index
  // serves the list, and no facet or term can widen past it.
  return {
    businessId: filters.businessId,
    role: { in: [...LISTED_ROLES[filters.currentUserRole]] },
    id: { not: filters.currentUserId },
    ...(and.length > 0 && { AND: and }),
  };
}

interface MasterListFilters {
  currentUserId?: string;
  search?: string;
  access?: UserAccess[];
  twoFactor?: UserTwoFactor[];
}

/**
 * The MASTER list's `where`: the platform's masters but the one asking, with
 * the same access/2FA facets and search as the company list.
 */
function masterListWhere(
  filters: MasterListFilters,
  { withFacets }: { withFacets: boolean },
): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];

  if (withFacets) {
    if (filters.access?.length === 1) {
      and.push({ access_revoked: filters.access[0] === "revoked" });
    }

    if (filters.twoFactor?.length === 1) {
      and.push({ two_factor_enabled: filters.twoFactor[0] === "enabled" });
    }
  }

  const term = filters.search?.trim() ?? "";

  if (term) {
    and.push(
      buildSearchOr<Prisma.UserWhereInput>([
        { id: { contains: term, mode: "insensitive" as const } },
        { name: { contains: term, mode: "insensitive" as const } },
        { email: { contains: term, mode: "insensitive" as const } },
      ]),
    );
  }

  return {
    role: "MASTER",
    ...(filters.currentUserId && { id: { not: filters.currentUserId } }),
    ...(and.length > 0 && { AND: and }),
  };
}

/** Users per combination of the four faceted columns, over the base. */
interface UserGroupCount {
  role: UserRole;
  access_revoked: boolean;
  two_factor_enabled: boolean;
  profileAccessId: string | null;
  count: number;
}

interface UserListSearchMeta {
  /** Every filter but access, so Ativos + Revogados = Total. */
  total: number;
  active: number;
  revoked: number;
  /** Every filter but 2FA: its card's share is over `twoFactorTotal`. */
  twoFactor: number;
  twoFactorTotal: number;
  /** Every filter applied; its share is over the pager total. */
  emailVerified: number;
  facets: {
    role: FacetCount[];
    access: FacetCount[];
    two_factor: FacetCount[];
    profileAccessId: FacetCount[];
  };
}

function valueOf(group: UserGroupCount, facet: UserFacet): string | null {
  switch (facet) {
    case "role":
      return group.role;
    case "access":
      return group.access_revoked ? "revoked" : "active";
    case "two_factor":
      return group.two_factor_enabled ? "enabled" : "disabled";
    case "profileAccessId":
      return group.profileAccessId;
  }
}

function selectedOf(
  filters: Pick<UserListFilters, "roles" | "access" | "twoFactor" | "profileAccessIds">,
  facet: UserFacet,
): readonly string[] | undefined {
  const selected = {
    role: filters.roles,
    access: filters.access,
    two_factor: filters.twoFactor,
    profileAccessId: filters.profileAccessIds,
  }[facet];

  return selected && selected.length > 0 ? selected : undefined;
}

/**
 * The pager total, the cards and every filter's options, from the grouped
 * counts. Disjunctive: a number broken down by a facet is counted with every
 * OTHER filter applied, never its own, so picking "Revogado" narrows the
 * table without zeroing the "Ativos" card.
 */
function summarizeUserList(
  groups: UserGroupCount[],
  filters: Pick<UserListFilters, "roles" | "access" | "twoFactor" | "profileAccessIds">,
  profileNames: ReadonlyMap<string, string> = new Map(),
  emailVerified = 0,
): { total: number; searchMeta: UserListSearchMeta } {
  const keeps = (group: UserGroupCount, except?: UserFacet) =>
    FACETS.every((facet) => {
      if (facet === except) return true;

      const selected = selectedOf(filters, facet);
      const value = valueOf(group, facet);

      return !selected || (value !== null && selected.includes(value));
    });

  const countBy = (facet: UserFacet): Map<string, number> => {
    const counts = new Map<string, number>();

    for (const group of groups) {
      const value = valueOf(group, facet);

      if (value === null || !keeps(group, facet)) continue;

      counts.set(value, (counts.get(value) ?? 0) + group.count);
    }

    return counts;
  };

  const closedSet = (facet: UserFacet, values: readonly string[]) => {
    const counts = countBy(facet);

    return values.map((value) => ({ value, count: counts.get(value) ?? 0 }));
  };

  const accessCounts = countBy("access");
  const twoFactorCounts = countBy("two_factor");

  // Every profile the base has, plus a selected one that zeroed, so its chip
  // keeps a name. Only names of this company's profiles ever reach here.
  const profileCounts = countBy("profileAccessId");
  const baseProfiles = new Set(
    groups.flatMap((group) => (group.profileAccessId ? [group.profileAccessId] : [])),
  );
  const profileOptions: FacetCount[] = [
    ...new Set([...baseProfiles, ...(filters.profileAccessIds ?? [])]),
  ]
    .filter((id) => profileNames.has(id))
    .map((id) => ({
      value: id,
      label: profileNames.get(id),
      count: profileCounts.get(id) ?? 0,
    }))
    .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "", "pt-BR"));

  const active = accessCounts.get("active") ?? 0;
  const revoked = accessCounts.get("revoked") ?? 0;
  const twoFactorOn = twoFactorCounts.get("enabled") ?? 0;
  const twoFactorOff = twoFactorCounts.get("disabled") ?? 0;

  return {
    total: groups
      .filter((group) => keeps(group))
      .reduce((sum, group) => sum + group.count, 0),
    searchMeta: {
      total: active + revoked,
      active,
      revoked,
      twoFactor: twoFactorOn,
      twoFactorTotal: twoFactorOn + twoFactorOff,
      emailVerified,
      facets: {
        role: closedSet("role", USER_ROLE_VALUES),
        access: closedSet("access", USER_ACCESS_VALUES),
        two_factor: closedSet("two_factor", USER_TWO_FACTOR_VALUES),
        profileAccessId: profileOptions,
      },
    },
  };
}

export {
  LISTED_ROLES,
  MASTER_SORT_KEYS,
  USER_ACCESS_VALUES,
  USER_ROLE_VALUES,
  USER_SORT,
  USER_SORT_FALLBACK,
  USER_SORT_KEYS,
  USER_TWO_FACTOR_VALUES,
  masterListWhere,
  rolesNamedBy,
  summarizeUserList,
  userListWhere,
  userSearchWhere,
  type ListedRole,
  type MasterListFilters,
  type MasterSortKey,
  type UserAccess,
  type UserGroupCount,
  type UserListFilters,
  type UserListSearchMeta,
  type UserSortKey,
  type UserTwoFactor,
};
