import { User, UserRole } from "@/modules/user/dtos/user-dto";

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
  users?: User[];
}

interface UpdateProfileAccess {
  profileAccessId: string;
  businessId: string;
  name?: string | null;
}

interface ListProfileAccess {
  data: ProfileAccess[];
  total: number;
}

interface ListProfileAccessProps {
  page: number;
  pageSize: number;
  businessId: string;
  currentUserRole: UserRole;
  profileAccessId: string;
  search?: string;
}

interface SearchProfileAccessWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
}

interface CursorPaginatedProfileAccess {
  data: ProfileAccess[];
  nextCursor: string | null;
  hasMore: boolean;
}

export {
  ProfileAccess,
  CreateProfileAccessProps,
  findProfileAccessByNameAndBusiness,
  ListProfileAccess,
  UpdateProfileAccess,
  ListProfileAccessProps,
  SearchProfileAccessWithCursorProps,
  CursorPaginatedProfileAccess,
};
