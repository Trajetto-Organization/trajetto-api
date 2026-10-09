import type { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import type { SortSpec } from "@/shared/pagination/list-query";
import {
  summarizeCatalogUsage,
  type CatalogLeader,
  type CatalogUsage,
} from "@/shared/pagination/catalog-usage";

/**
 * The access-profile list's server-side table (decision 8.8): what it sorts
 * by and how a typed term is matched. It has no facets; its numbers are the
 * users and permissions each profile holds, counted by the database.
 */

/** Same ids as the web table's columns, so the URL value is the column id. */
const PROFILE_SORT_KEYS = [
  "created_at",
  "updated_at",
  "name",
  "usersCount",
  "permissionsCount",
] as const;

type ProfileSortKey = (typeof PROFILE_SORT_KEYS)[number];

const PROFILE_SORT_FALLBACK = { sort: "created_at", order: "desc" } as const;

type OrderBy = Prisma.ProfileAccessOrderByWithRelationInput;

const PROFILE_SORT: SortSpec<ProfileSortKey, OrderBy> = {
  keys: PROFILE_SORT_KEYS,
  fallback: PROFILE_SORT_FALLBACK,
  columns: {
    created_at: (order) => ({ created_at: order }),
    updated_at: (order) => ({ updated_at: order }),
    name: (order) => ({ name: order }),
    usersCount: (order) => ({ users: { _count: order } }),
    permissionsCount: (order) => ({ permissions: { _count: order } }),
  },
  tiebreaker: [{ created_at: "desc" }, { id: "desc" }],
};

interface ProfileListFilters {
  businessId: string;
  search?: string;
  /**
   * A BUSINESS_USER never sees (nor edits) the profile they themselves use:
   * editing it would change their own permissions.
   */
  hideProfileId?: string | null;
}

function profileListWhere(filters: ProfileListFilters): Prisma.ProfileAccessWhereInput {
  const term = filters.search?.trim() ?? "";

  return {
    // Tenant first: a term can never widen past the company.
    businessId: filters.businessId,
    ...(filters.hideProfileId && { id: { not: filters.hideProfileId } }),
    ...(term &&
      buildSearchOr<Prisma.ProfileAccessWhereInput>([
        { id: { contains: term, mode: "insensitive" as const } },
        { name: { contains: term, mode: "insensitive" as const } },
      ])),
  };
}

/**
 * The cards (`meta.searchMeta`), over every profile the search finds — the
 * one a BUSINESS_USER cannot see left out, as in the table.
 */
interface ProfileListSearchMeta {
  /** Profiles of the search: the pager's total. */
  total: number;
  /** Users holding one of them (the sum of the "Usuários" column). */
  linkedUsers: number;
  /** Profiles nobody holds: candidates to delete or to hand out. */
  withoutUsers: number;
  /** The profile most people hold; null while nobody holds any. */
  mostUsed: CatalogLeader | null;
}

/** Folds the users count of each profile of the search (the repository's `usage`). */
function summarizeProfileList(usage: ReadonlyArray<CatalogUsage>): ProfileListSearchMeta {
  const { total, linked, unused, leader } = summarizeCatalogUsage(usage);

  return { total, linkedUsers: linked, withoutUsers: unused, mostUsed: leader };
}

export {
  summarizeProfileList,
  type ProfileListSearchMeta,
  PROFILE_SORT,
  PROFILE_SORT_FALLBACK,
  PROFILE_SORT_KEYS,
  profileListWhere,
  type ProfileListFilters,
  type ProfileSortKey,
};
