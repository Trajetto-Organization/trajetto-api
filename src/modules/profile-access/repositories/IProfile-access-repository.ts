import {
  CreateProfileAccessProps,
  findProfileAccessByNameAndBusiness,
  ListProfileAccess,
  ListProfileAccessProps,
  ProfileAccess,
  UpdateProfileAccess,
  SearchProfileAccessWithCursorProps,
  CursorPaginatedProfileAccess,
} from "../dtos/profile-access-dto";

interface IProfileAccessRepository {
  createProfileAccess: ({
    name,
    businessId,
  }: CreateProfileAccessProps) => Promise<ProfileAccess>;
  listProfileAccess: (
    profileAccess: ListProfileAccessProps,
  ) => Promise<ListProfileAccess>;
  searchProfileAccessWithCursor: (
    props: SearchProfileAccessWithCursorProps,
  ) => Promise<CursorPaginatedProfileAccess>;
  updateProfileAccess: (
    profileAccessData: UpdateProfileAccess,
  ) => Promise<ProfileAccess>;
  deleteProfileAccess: (profileAccessId: string) => Promise<ProfileAccess>;
  findProfileAccessByNameAndBusiness: ({
    name,
    businessId,
  }: findProfileAccessByNameAndBusiness) => Promise<ProfileAccess | null>;
  findProfileAccessById: (
    profileAccessId: string,
  ) => Promise<ProfileAccess | null>;
}

export { IProfileAccessRepository };
