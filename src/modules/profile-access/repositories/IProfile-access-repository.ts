import {
  CreateProfileAccessProps,
  findProfileAccessByNameAndBusiness,
  ListProfileAccess,
  ListProfileAccessProps,
  ListProfileBusinessProps,
  ProfileAccess,
  UpdateProfileAccess,
} from "../dtos/profile-access-dto";

interface IProfileAccessRepository {
  createProfileAccess: ({
    name,
    businessId,
  }: CreateProfileAccessProps) => Promise<ProfileAccess>;
  listProfileAccess: (
    profileAccess: ListProfileAccessProps,
  ) => Promise<ListProfileAccess>;
  listProfileBusiness: ({
    page,
    pageSize,
    businessId,
  }: ListProfileBusinessProps) => Promise<ListProfileAccess>;
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
