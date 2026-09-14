import { v7 as uuidV7 } from "uuid";
import { IUserRepository } from "../IUser-repository";

import {
  CreateUserProps,
  ListUsers,
  ListUsersByRoleAndBusinessProps,
  UpdateTwoFactorAuthentication,
  UpdateUser,
  UpdateUserName,
  UpdateUserPassword,
  UpdateUserEmailVerification,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  CreateMasterUserProps,
  ListMasterUsersProps,
  User,
  SearchUserWithCursorProps,
  CursorPaginatedUser,
} from "../../dtos/user-dto";

class InMemoryUserRepository implements IUserRepository {
  public user: User[] = [];

  async createUser({
    email,
    password,
    name,
    role,
    businessId,
    profileAccessId,
    driverId,
    whatsapp_notifications_enabled,
    whatsapp_phone,
  }: CreateUserProps): Promise<User> {
    const now = new Date();
    const user: User & { created_at: Date; updated_at: Date } = {
      id: uuidV7(),
      role: role || "BUSINESS_USER",
      email,
      name,
      password: password || "default-password",
      businessId,
      profileAccessId,
      driverId: driverId ?? null,
      two_factor_enabled: false,
      access_revoked: false,
      session_version: 0,
      email_verified: null,
      avatar: null,
      whatsapp_notifications_enabled: whatsapp_notifications_enabled ?? false,
      email_notifications_enabled: true,
      activity_notifications_enabled: true,
      whatsapp_phone: whatsapp_phone ?? null,
      created_at: now,
      updated_at: now,
    };

    this.user.push(user);
    return user;
  }

  async listUsers({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
  }: ListUsersByRoleAndBusinessProps): Promise<ListUsers> {
    let filteredUsers =
      currentUserRole === "MASTER"
        ? [...this.user]
        : this.user.filter((user) => user.businessId === businessId);

    if (search) {
      const searchLower = search.toLowerCase();
      filteredUsers = filteredUsers.filter(
        (user) =>
          user.name.toLowerCase().includes(searchLower) ||
          user.email.toLowerCase().includes(searchLower),
      );
    }

    const skip = (page - 1) * pageSize;
    const slicedUsers = filteredUsers.slice(skip, skip + pageSize);

    const data = slicedUsers.map((user) => ({
      ...user,
      profileAccess: user.profileAccess
        ? { name: user.profileAccess.name }
        : null,
      created_at: (user as any).created_at || new Date(),
      updated_at: (user as any).updated_at || new Date(),
    }));

    const total = filteredUsers.length;
    return { data: data as any, total };
  }

  async updateUser({ userId, userData }: UpdateUser): Promise<User> {
    const index = this.user.findIndex((user) => user.id === userId);

    if (index === -1) {
      throw new Error("User not found");
    }

    // Only skip undefined values — null is a valid value (means "clear/disconnect")
    const filteredData = Object.fromEntries(
      Object.entries(userData).filter(([, value]) => value !== undefined),
    );

    const updatedUser = {
      ...this.user[index],
      ...filteredData,
      ...(userData.password
        ? { session_version: (this.user[index].session_version ?? 0) + 1 }
        : {}),
    };

    this.user[index] = updatedUser;
    return updatedUser;
  }

  async deleteUser(userId: string): Promise<User> {
    const index = this.user.findIndex((user) => user.id === userId);

    if (index === -1) {
      throw new Error("User not found");
    }

    const deletedUser = this.user.splice(index, 1)[0];
    return deletedUser;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const findUserByEmail = this.user.find((user) => user.email === email);

    if (!findUserByEmail) {
      return null;
    }

    return findUserByEmail;
  }

  async findUserById(userId: string): Promise<User | null> {
    const findUserById = this.user.find((user) => user.id === userId);

    if (!findUserById) {
      return null;
    }

    return findUserById;
  }

  async updateUserPassword({
    userId,
    password,
  }: UpdateUserPassword): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.password = password;
    user.session_version = (user.session_version ?? 0) + 1;
    return user;
  }

  async updateUserName({ userId, name }: UpdateUserName): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.name = name;
    return user;
  }

  async updateTwoFactorAuthentication({
    userId,
    isTwoFactorEnabled,
  }: UpdateTwoFactorAuthentication): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.two_factor_enabled = isTwoFactorEnabled;
    return user;
  }

  async updateEmailVerification({
    email,
    email_verified,
    userId,
  }: UpdateUserEmailVerification): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.email = email;
    user.email_verified = email_verified;

    return user;
  }

  async findUserByEmailAndBusinessId(
    email: string,
    businessId: string,
  ): Promise<User | null> {
    const findUser = this.user.find(
      (user) => user.email === email && user.businessId === businessId,
    );

    return findUser || null;
  }

  async findUsersByBusiness(businessId: string): Promise<User[]> {
    return this.user.filter((user) => user.businessId === businessId);
  }

  async updateUserAccessRevocation({
    userId,
    isAccessRevoke,
  }: UpdateUserAccessRevocation): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.access_revoked = isAccessRevoke;
    user.session_version = (user.session_version ?? 0) + 1;
    return user;
  }

  async invalidateUserSessions(userId: string): Promise<User | null> {
    const user = this.user.find((item) => item.id === userId);

    if (!user) return null;

    user.session_version = (user.session_version ?? 0) + 1;
    return user;
  }

  async updateWhatsAppSettings({
    userId,
    whatsapp_notifications_enabled,
    whatsapp_phone,
  }: UpdateUserWhatsAppSettings): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.whatsapp_notifications_enabled = whatsapp_notifications_enabled;

    if (whatsapp_phone !== undefined) {
      user.whatsapp_phone = whatsapp_phone;
    }

    return user;
  }

  async findBusinessAdminsByBusinessId(businessId: string): Promise<User[]> {
    return this.user.filter(
      (user) =>
        user.businessId === businessId && user.role === "BUSINESS_ADMIN",
    );
  }

  async findOtherMasters(excludeUserId: string): Promise<User[]> {
    return this.user.filter(
      (user) => user.role === "MASTER" && user.id !== excludeUserId,
    );
  }

  async findUserByDriverId(driverId: string): Promise<User | null> {
    const findUserByDriverId = this.user.find(
      (user) => user.driverId === driverId,
    );

    return findUserByDriverId || null;
  }


  async findUserWithWhatsAppByPhone(
    phoneNumber: string,
    excludeUserId?: string,
  ): Promise<User | null> {
    // Mirrors the Prisma query: only enabled users hold a number, so a kept
    // number on a disabled account never blocks someone else from using it.
    const findUser = this.user.find(
      (user) =>
        user.whatsapp_phone === phoneNumber &&
        user.whatsapp_notifications_enabled === true &&
        (excludeUserId ? user.id !== excludeUserId : true),
    );

    return findUser || null;
  }

  async updateAvatar(
    userId: string,
    avatarPath: string | null,
  ): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.avatar = avatarPath;
    return user;
  }

  async createMasterUser({
    name,
    email,
    password,
  }: CreateMasterUserProps): Promise<User> {
    const now = new Date();
    const masterUser: User = {
      id: uuidV7(),
      name,
      email,
      password,
      role: "MASTER",
      access_revoked: false,
      session_version: 0,
      email_verified: now,
      created_at: now,
      updated_at: now,
    } as User;

    this.user.push(masterUser);
    return masterUser;
  }

  async listMasterUsers({
    page,
    pageSize,
    search,
    currentUserId,
  }: ListMasterUsersProps): Promise<ListUsers> {
    let masters = this.user.filter(
      (u) => u.role === "MASTER" && (!currentUserId || u.id !== currentUserId),
    );

    if (search) {
      const s = search.toLowerCase();
      masters = masters.filter(
        (u) =>
          u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s),
      );
    }

    const total = masters.length;
    const skip = (page - 1) * pageSize;

    const data = masters.slice(skip, skip + pageSize);
    return { data: data as any, total };
  }

  async searchUserWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchUserWithCursorProps): Promise<CursorPaginatedUser> {
    let filtered = this.user.filter((u) => u.businessId === businessId);

    if (cursor) {
      const cursorIndex = filtered.findIndex((u) => u.id === cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data: data as any, nextCursor, hasMore };
  }
}

export { InMemoryUserRepository };
