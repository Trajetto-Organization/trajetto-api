import type { SortOrder } from "@/shared/pagination/list-query";

import type { CatalogUsage } from "@/shared/pagination/catalog-usage";

import type {
  ProfileListFilters,
  ProfileListSearchMeta,
  ProfileSortKey,
} from "../usecases/list-profile-access/profile-access-list";

interface CreateProfileAccessProps {
  name: string;
  businessId: string;
}

interface findProfileAccessByNameAndBusiness {
  name: string;
  businessId: string;
}

interface ProfileAccess {
  id: string;
  name: string;
  corporate_reason?: string;
  businessId?: string;
  created_at?: Date;
  updated_at?: Date;

  /** Users linked to the profile (findProfileAccessById counts them). */
  usersCount?: number;
}

/** A line of GET /profile-access/list-profile-access. */
interface ProfileAccessListRow {
  id: string;
  name: string;
  businessId: string;
  created_at: Date;
  updated_at: Date;
  usersCount: number;
  permissionsCount: number;
}

interface UpdateProfileAccess {
  profileAccessId: string;
  /** Only compared with the profile's own: a profile never changes company. */
  businessId?: string;
  name?: string | null;
}

interface ListProfileAccess {
  data: ProfileAccessListRow[];
  total: number;
  /** Users per profile over the whole search, for the cards. */
  usage: CatalogUsage[];
}

/** What the list use case answers: the page, the pager total and the cards. */
interface ListProfileAccessResult {
  data: ProfileAccessListRow[];
  total: number;
  meta: ProfileListSearchMeta;
}

interface ListProfileAccessProps extends ProfileListFilters {
  page: number;
  pageSize: number;
  sort?: ProfileSortKey;
  order?: SortOrder;
}

interface SearchProfileAccessWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  /** The typed term, matched against the profile's name. */
  search?: string;
  /** Left out of the answer (the asker's own profile, when it must be). */
  hideProfileId?: string | null;
}

interface CursorPaginatedProfileAccess {
  data: ProfileAccess[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  ProfileAccess,
  ProfileAccessListRow,
  CreateProfileAccessProps,
  findProfileAccessByNameAndBusiness,
  ListProfileAccess,
  ListProfileAccessResult,
  UpdateProfileAccess,
  ListProfileAccessProps,
  SearchProfileAccessWithCursorProps,
  CursorPaginatedProfileAccess,
};
