import { afterCursor, newestFirst } from "@/shared/in-memory/cursor";
import { Prisma } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import { IProfileAccessRepository } from "../IProfile-access-repository";

import {
  CreateProfileAccessProps,
  ProfileAccess,
  ListProfileAccess,
  UpdateProfileAccess,
  findProfileAccessByNameAndBusiness,
  ListProfileAccessProps,
  SearchProfileAccessWithCursorProps,
  CursorPaginatedProfileAccess,
} from "../../dtos/profile-access-dto";

import {
  PROFILE_SORT_FALLBACK,
  type ProfileSortKey,
} from "../../usecases/list-profile-access/profile-access-list";

import type { SortOrder } from "@/shared/pagination/list-query";
import { compareForOrder } from "@/shared/pagination/in-memory-order";

type StoredProfile = ProfileAccess & { created_at?: Date; updated_at?: Date };

/** Rows elsewhere that point at a profile (users, permissions). */
interface ProfileLinks {
  users?: () => ReadonlyArray<{ profileAccessId?: string | null }>;
  permissions?: () => ReadonlyArray<{ profileAccessId: string }>;
}

function recordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "An operation failed because it depends on one or more records that were required but not found.",
    { code: "P2025", clientVersion: "in-memory" },
  );
}

function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${target}\`)`,
    { code: "P2002", clientVersion: "in-memory", meta: { target: [target] } },
  );
}

const time = (value: Date | undefined) =>
  value ? new Date(value).getTime() : 0;

/**
 * The Prisma repository's twin: tenant filter, search, order with the same
 * tiebreaker, counts of what points at each profile, P2025 on a missing row
 * (the old fake spliced index -1 and wrote a partial object).
 */
class InMemoryProfileAccessRepository implements IProfileAccessRepository {
  public profileAccess: StoredProfile[] = [];

  constructor(private readonly links: ProfileLinks = {}) {}

  private usersOf(id: string): number {
    return (this.links.users?.() ?? []).filter(
      (user) => user.profileAccessId === id,
    ).length;
  }

  private permissionsOf(id: string): number {
    return (this.links.permissions?.() ?? []).filter(
      (permission) => permission.profileAccessId === id,
    ).length;
  }

  async createProfileAccess({
    name,
    businessId,
  }: CreateProfileAccessProps): Promise<ProfileAccess> {
    // @@unique([name, businessId]), as Postgres raises it (case-sensitive).
    if (
      this.profileAccess.some(
        (profile) => profile.name === name && profile.businessId === businessId,
      )
    ) {
      throw uniqueViolation("name");
    }

    const now = new Date();
    const newProfileAccess: StoredProfile = {
      id: uuidV7(),
      name,
      businessId,
      created_at: now,
      updated_at: now,
    };

    this.profileAccess.push(newProfileAccess);
    return newProfileAccess;
  }

  private sortValue(
    profile: StoredProfile,
    key: ProfileSortKey,
  ): string | number {
    switch (key) {
      case "created_at":
        return time(profile.created_at);
      case "updated_at":
        return time(profile.updated_at);
      case "name":
        return profile.name;
      case "usersCount":
        return this.usersOf(profile.id);
      case "permissionsCount":
        return this.permissionsOf(profile.id);
    }
  }

  async listProfileAccess({
    page,
    pageSize,
    sort,
    order,
    businessId,
    search,
    hideProfileId,
  }: ListProfileAccessProps): Promise<ListProfileAccess> {
    const term = search?.trim().toLocaleLowerCase("pt-BR") ?? "";

    const filtered = this.profileAccess.filter(
      (profile) =>
        profile.businessId === businessId &&
        (!hideProfileId || profile.id !== hideProfileId) &&
        (!term ||
          profile.id.toLowerCase().includes(term) ||
          profile.name.toLocaleLowerCase("pt-BR").includes(term)),
    );

    const key = sort ?? PROFILE_SORT_FALLBACK.sort;
    const direction: SortOrder =
      order ?? (sort ? "asc" : PROFILE_SORT_FALLBACK.order);

    // The comparator every twin shares (table-infra contract): code-point
    // strings and the same created_at desc, id desc tiebreaker as Postgres.
    const sorted = [...filtered].sort(
      (a, b) =>
        compareForOrder(
          this.sortValue(a, key),
          this.sortValue(b, key),
          direction,
        ) ||
        compareForOrder(time(a.created_at), time(b.created_at), "desc") ||
        compareForOrder(a.id, b.id, "desc"),
    );

    const skip = (page - 1) * pageSize;

    return {
      data: sorted.slice(skip, skip + pageSize).map((profile) => ({
        id: profile.id,
        name: profile.name,
        businessId: profile.businessId as string,
        created_at: profile.created_at ?? new Date(0),
        updated_at: profile.updated_at ?? new Date(0),
        usersCount: this.usersOf(profile.id),
        permissionsCount: this.permissionsOf(profile.id),
      })),
      total: filtered.length,
      usage: filtered.map((profile) => ({
        id: profile.id,
        label: profile.name,
        count: this.usersOf(profile.id),
      })),
    };
  }

  async updateProfileAccess({
    profileAccessId,
    name,
  }: UpdateProfileAccess): Promise<ProfileAccess> {
    const index = this.profileAccess.findIndex(
      (profile) => profile.id === profileAccessId,
    );

    if (index === -1) throw recordNotFound();

    const current = this.profileAccess[index];

    if (
      name &&
      this.profileAccess.some(
        (profile) =>
          profile.id !== profileAccessId &&
          profile.name === name &&
          profile.businessId === current.businessId,
      )
    ) {
      throw uniqueViolation("name");
    }

    const updatedProfileAccess = {
      ...this.profileAccess[index],
      name: name || this.profileAccess[index].name,
      updated_at: new Date(),
    };

    this.profileAccess[index] = updatedProfileAccess;
    return updatedProfileAccess;
  }

  async deleteProfileAccess(profileAccessId: string): Promise<ProfileAccess> {
    const index = this.profileAccess.findIndex(
      (profile) => profile.id === profileAccessId,
    );

    if (index === -1) throw recordNotFound();

    const deletedProfile = this.profileAccess.splice(index, 1)[0];
    return deletedProfile;
  }

  async findProfileAccessByNameAndBusiness({
    name,
    businessId,
  }: findProfileAccessByNameAndBusiness): Promise<ProfileAccess | null> {
    const found = this.profileAccess.find(
      (profile) =>
        profile.name.toLowerCase() === name.toLowerCase() &&
        profile.businessId === businessId,
    );

    return found ?? null;
  }

  async findProfileAccessById(
    profileAccessId: string,
  ): Promise<ProfileAccess | null> {
    const found = this.profileAccess.find(
      (profile) => profile.id === profileAccessId,
    );

    return found ? { ...found, usersCount: this.usersOf(found.id) } : null;
  }

  async searchProfileAccessWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
    hideProfileId,
  }: SearchProfileAccessWithCursorProps): Promise<CursorPaginatedProfileAccess> {
    const term = search?.trim().toLocaleLowerCase("pt-BR") ?? "";

    let filtered = this.profileAccess
      .filter(
        (profile) =>
          profile.businessId === businessId &&
          (!hideProfileId || profile.id !== hideProfileId) &&
          (!term || profile.name.toLocaleLowerCase("pt-BR").includes(term)),
      )
      .sort(
        (a, b) =>
          compareForOrder(time(a.created_at), time(b.created_at), "desc") ||
          compareForOrder(a.id, b.id, "desc"),
      );

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.profileAccess, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }
}

export { InMemoryProfileAccessRepository };
