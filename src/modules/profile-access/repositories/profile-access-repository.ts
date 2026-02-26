import database from "@/../infra/database";
import { IProfileAccessRepository } from "./IProfile-access-repository";

import {
  CreateProfileAccessProps,
  findProfileAccessByNameAndBusiness,
  ListProfileAccess,
  ListProfileAccessProps,
  ListProfileBusinessProps,
  ProfileAccess,
  UpdateProfileAccess,
} from "../dtos/profile-access-dto";

class ProfileAccessRepository implements IProfileAccessRepository {
  constructor(private prisma = database) {}

  async createProfileAccess({
    name,
    businessId,
  }: CreateProfileAccessProps): Promise<ProfileAccess> {
    const createdProfileAccess = await this.prisma.profileAccess.create({
      data: {
        name: name,
        businessId: businessId,
      },
    });

    return createdProfileAccess;
  }

  async listProfileAccess({
    page,
    pageSize,
    currentUserRole,
    businessId,
    profileAccessId,
    search,
  }: ListProfileAccessProps): Promise<ListProfileAccess> {
    const skip = (page - 1) * pageSize;

    const normalizedSearch = search ? search.trim().toLowerCase() : "";
    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { name: { contains: normalizedSearch, mode: "insensitive" } },
        {
          ...(currentUserRole === "MASTER"
            ? {
                businessId: { contains: normalizedSearch, mode: "insensitive" },
              }
            : {}),
        },
        {
          ...(currentUserRole === "MASTER"
            ? {
                business: {
                  corporate_reason: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              }
            : {}),
        },
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId }),
      ...(currentUserRole === "BUSINESS_USER" && {
        id: { not: profileAccessId },
      }),
      ...(orConditions.length > 0 ? { OR: orConditions } : {}),
    };

    const profileAccessData = await this.prisma.profileAccess.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      ...(currentUserRole === "MASTER" && {
        include: {
          business: {
            select: {
              id: true,
              corporate_reason: true,
            },
          },
        },
      }),
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    const total = await this.prisma.profileAccess.count({
      where: whereCondition,
    });

    return { data: profileAccessData, total };
  }

  async listProfileBusiness({
    page,
    pageSize,
    businessId,
  }: ListProfileBusinessProps): Promise<ListProfileAccess> {
    const skip = (page - 1) * pageSize;

    const profileBusinessData = await this.prisma.profileAccess.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
    });

    const total = await this.prisma.profileAccess.count({
      where: {
        businessId,
      },
    });

    return { data: profileBusinessData, total };
  }

  async updateProfileAccess(
    profileAccessData: UpdateProfileAccess,
  ): Promise<ProfileAccess> {
    const { profileAccessId, ...dataToUpdate } = profileAccessData;

    const filteredData = Object.fromEntries(
      Object.entries(dataToUpdate).filter(
        ([_, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    return this.prisma.$transaction(async (prisma) => {
      // Update ProfileAccess
      const updatedProfile = await prisma.profileAccess.update({
        where: { id: profileAccessId },
        data: filteredData,
      });

      // Updates related permissions
      await prisma.permission.updateMany({
        where: { profileAccessId },
        data: { businessId: filteredData.businessId as string },
      });

      // Updates related users
      await prisma.user.updateMany({
        where: { profileAccessId },
        data: { businessId: filteredData.businessId },
      });

      return updatedProfile;
    });
  }

  async deleteProfileAccess(profileAccessId: string): Promise<ProfileAccess> {
    const deleteProfileAccess = await this.prisma.profileAccess.delete({
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
        name: {
          equals: name,
          mode: "insensitive",
        },
        businessId: businessId,
      },
    });

    return findUserByEmail;
  }

  async findProfileAccessById(
    profileAccessId: string,
  ): Promise<ProfileAccess | null> {
    const findProfileAccessById = await this.prisma.profileAccess.findUnique({
      where: {
        id: profileAccessId,
      },
      include: {
        users: true,
      },
    });

    return findProfileAccessById;
  }
}

export { ProfileAccessRepository };
