import { v4 as uuidV4 } from "uuid";

import { IProfileAccessRepository } from "../IProfile-access-repository";
import {
  CreateProfileAccessProps,
  ProfileAccess,
  ListProfileAccess,
  ListProfileBusinessProps,
  UpdateProfileAccess,
  findProfileAccessByNameAndBusiness,
  ListProfileAccessProps,
} from "../../dtos/profile-access-dto";

class InMemoryProfileAccessRepository implements IProfileAccessRepository {
  public profileAccess: ProfileAccess[] = [];

  async createProfileAccess({
    name,
    businessId,
  }: CreateProfileAccessProps): Promise<ProfileAccess> {
    const newProfileAccess: ProfileAccess = {
      id: uuidV4(),
      name,
      businessId,
    };

    this.profileAccess.push(newProfileAccess);
    return newProfileAccess;
  }

  async listProfileAccess({
    page,
    pageSize,
    businessId,
    currentUserRole,
    profileAccessId,
    search,
  }: ListProfileAccessProps): Promise<ListProfileAccess> {
    let filteredProfiles = this.profileAccess;

    // Filter by business if not MASTER
    if (currentUserRole !== "MASTER") {
      filteredProfiles = filteredProfiles.filter(
        (profile) => profile.businessId === businessId,
      );
    }

    // BUSINESS_USER should not see their own profile access
    if (currentUserRole === "BUSINESS_USER" && profileAccessId) {
      filteredProfiles = filteredProfiles.filter(
        (profile) => profile.id !== profileAccessId,
      );
    }

    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      filteredProfiles = filteredProfiles.filter((profile) =>
        profile.name.toLowerCase().includes(searchLower),
      );
    }

    const skip = (page - 1) * pageSize;

    const data = filteredProfiles.slice(skip, skip + pageSize);
    const total = filteredProfiles.length;

    return { data, total };
  }

  async listProfileBusiness({
    page,
    pageSize,
    businessId,
  }: ListProfileBusinessProps): Promise<ListProfileAccess> {
    const skip = (page - 1) * pageSize;

    const filteredProfiles = this.profileAccess.filter(
      (profile) => profile.businessId === businessId,
    );

    const data = filteredProfiles.slice(skip, skip + pageSize);
    return { data, total: filteredProfiles.length };
  }

  async updateProfileAccess({
    profileAccessId,
    name,
  }: UpdateProfileAccess): Promise<ProfileAccess> {
    const index = this.profileAccess.findIndex(
      (profile) => profile.id === profileAccessId,
    );

    const updatedProfileAccess = {
      ...this.profileAccess[index],
      name: name ?? this.profileAccess[index].name,
      updated_at: new Date(),
    };

    this.profileAccess[index] = updatedProfileAccess;
    return updatedProfileAccess;
  }

  async deleteProfileAccess(profileAccessId: string): Promise<ProfileAccess> {
    const index = this.profileAccess.findIndex(
      (profile) => profile.id === profileAccessId,
    );

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

    if (!found) {
      return null;
    }

    return found;
  }

  async findProfileAccessById(
    profileAccessId: string,
  ): Promise<ProfileAccess | null> {
    const found = this.profileAccess.find(
      (profile) => profile.id === profileAccessId,
    );

    if (!found) {
      return null;
    }

    return found;
  }
}

export { InMemoryProfileAccessRepository };
