import { Prisma } from "@prisma/client";

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

/**
 * The writes take an optional `tx`: a profile change and its audit entry
 * commit together (OUTBOX-10).
 */
interface IProfileAccessRepository {
  createProfileAccess: (
    { name, businessId }: CreateProfileAccessProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<ProfileAccess>;
  listProfileAccess: (
    profileAccess: ListProfileAccessProps,
  ) => Promise<ListProfileAccess>;
  searchProfileAccessWithCursor: (
    props: SearchProfileAccessWithCursorProps,
  ) => Promise<CursorPaginatedProfileAccess>;
  updateProfileAccess: (
    profileAccessData: UpdateProfileAccess,
    tx?: Prisma.TransactionClient,
  ) => Promise<ProfileAccess>;
  deleteProfileAccess: (
    profileAccessId: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<ProfileAccess>;
  findProfileAccessByNameAndBusiness: ({
    name,
    businessId,
  }: findProfileAccessByNameAndBusiness) => Promise<ProfileAccess | null>;
  findProfileAccessById: (
    profileAccessId: string,
  ) => Promise<ProfileAccess | null>;
}

export { IProfileAccessRepository };
