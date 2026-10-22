import { Prisma } from "@prisma/client";

import database from "@/../infra/database";
import { IProfileAccessRepository } from "./IProfile-access-repository";

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

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";
import { insensitiveEquals } from "@/shared/utils/like-pattern";

import {
  PROFILE_SORT,
  profileListWhere,
} from "../usecases/list-profile-access/profile-access-list";

class ProfileAccessRepository implements IProfileAccessRepository {
  constructor(private prisma = database) {}

  async createProfileAccess(
    { name, businessId }: CreateProfileAccessProps,
    tx?: Prisma.TransactionClient,
  ): Promise<ProfileAccess> {
    const createdProfileAccess = await (tx ?? this.prisma).profileAccess.create(
      {
        data: {
          name: name,
          businessId: businessId,
        },
      },
    );

    return createdProfileAccess;
  }

  async listProfileAccess({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListProfileAccessProps): Promise<ListProfileAccess> {
    const where = profileListWhere(filters);

    const [rows, usage] = await Promise.all([
      this.prisma.profileAccess.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where,
        include: { _count: { select: { users: true, permissions: true } } },
        orderBy: resolveOrderBy(PROFILE_SORT, { sort, order }),
      }),
      // One users count per profile of the whole search, for the cards: a
      // company holds a few dozen profiles at most, so this also answers the
      // pager total without a separate COUNT.
      this.prisma.profileAccess.findMany({
        where,
        select: { id: true, name: true, _count: { select: { users: true } } },
      }),
    ]);

    return {
      data: rows.map(({ _count, ...profile }) => ({
        ...profile,
        usersCount: _count.users,
        permissionsCount: _count.permissions,
      })),
      total: usage.length,
      usage: usage.map(({ id, name, _count }) => ({
        id,
        label: name,
        count: _count.users,
      })),
    };
  }

  /**
   * Renames the profile. It never changes company: moving a profile used to
   * carry its users into another company without ending their sessions or
   * clearing their inbox (decision 4.6). A person changes company through
   * their own record, where that is handled.
   */
  async updateProfileAccess(
    { profileAccessId, name }: UpdateProfileAccess,
    tx?: Prisma.TransactionClient,
  ): Promise<ProfileAccess> {
    return (tx ?? this.prisma).profileAccess.update({
      where: { id: profileAccessId },
      data: { ...(name && { name }) },
    });
  }

  async deleteProfileAccess(
    profileAccessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProfileAccess> {
    const deleteProfileAccess = await (tx ?? this.prisma).profileAccess.delete({
      where: {
        id: profileAccessId,
      },
    });

    return deleteProfileAccess;
  }

  async findProfileAccessByNameAndBusiness({
    name,
    businessId,
  }: findProfileAccessByNameAndBusiness): Promise<ProfileAccess | null> {
    const findUserByEmail = await this.prisma.profileAccess.findFirst({
      where: {
        // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
        name: insensitiveEquals(name),
        businessId: businessId,
      },
    });

    return findUserByEmail;
  }

  async searchProfileAccessWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
    hideProfileId,
  }: SearchProfileAccessWithCursorProps): Promise<CursorPaginatedProfileAccess> {
    const term = search?.trim() ?? "";

    const items = await this.prisma.profileAccess.findMany({
      where: {
        businessId,
        ...(hideProfileId && { id: { not: hideProfileId } }),
        ...(term &&
          buildSearchOr<Prisma.ProfileAccessWhereInput>([
            { name: { contains: term, mode: "insensitive" as const } },
          ])),
      },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      // The id breaks created_at ties, so a cursor never skips a row.
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async findProfileAccessById(
    profileAccessId: string,
  ): Promise<ProfileAccess | null> {
    // The count, not the rows: the callers need to know whether anybody uses
    // the profile, and the rows carried every user's password hash.
    const found = await this.prisma.profileAccess.findUnique({
      where: { id: profileAccessId },
      include: { _count: { select: { users: true } } },
    });

    if (!found) return null;

    const { _count, ...profile } = found;

    return { ...profile, usersCount: _count.users };
  }
}

export { ProfileAccessRepository };
