import { v4 as uuidV4 } from "uuid";
import { IUserRepository } from "../IUser-repository";

import {
  CreateUserProps,
  ListUsers,
  ListUsersByRoleAndBusinessProps,
  ListUserBusinessProps,
  UpdateTwoFactorAuthentication,
  UpdateUser,
  UpdateUserName,
  UpdateUserPassword,
  UpdateUserEmailVerification,
  UpdateUserAccessRevocation,
  UpdateUserWhatsAppSettings,
  UpdateEmailNotifications,
  UpdateActivityNotifications,
  User,
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
    whatsapp_notifications_enabled,
    whatsapp_phone,
    whatsapp_instance_connected,
  }: CreateUserProps): Promise<User> {
    const user: User = {
      id: uuidV4(),
      role: role || "BUSINESS_USER",
      email,
      name,
      password: password || "default-password",
      businessId,
      profileAccessId,
      two_factor_enabled: false,
      access_revoked: false,
      email_verified: null,
      avatar: null,
      whatsapp_notifications_enabled: whatsapp_notifications_enabled ?? false,
      email_notifications_enabled: true,
      activity_notifications_enabled: true,
      whatsapp_phone: whatsapp_phone ?? null,
      whatsapp_instance_connected: whatsapp_instance_connected ?? false,
    };

    this.user.push(user);
    return user;
  }

  async listUsers({
    page,
    pageSize,
  }: ListUsersByRoleAndBusinessProps): Promise<ListUsers> {
    const skip = (page - 1) * pageSize;
    const slicedUsers = this.user.slice(skip, skip + pageSize);

    const data = slicedUsers.map((user) => ({
      ...user,
      // If profileAccess exists, get the name, otherwise set to null or another default value
      profileAccess: user.profileAccess ? user.profileAccess.name : null,
    }));

    const total = this.user.length;
    return { data, total };
  }

  async updateUser({ userId, userData }: UpdateUser): Promise<User> {
    const index = this.user.findIndex((user) => user.id === userId);

    if (index === -1) {
      throw new Error("User not found");
    }

    const filteredData = Object.fromEntries(
      Object.entries(userData).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    const updatedUser = {
      ...this.user[index],
      ...filteredData,
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

  async listUserBusiness({
    page,
    pageSize,
    businessId,
  }: ListUserBusinessProps): Promise<ListUsers> {
    const filteredUsers = this.user.filter(
      (user) => user.businessId === businessId,
    );
    const skip = (page - 1) * pageSize;
    const slicedUsers = filteredUsers.slice(skip, skip + pageSize);

    const users = slicedUsers.map((user) => ({
      ...user,
      profileAccess: user.profileAccess ? user.profileAccess.name : null,
    }));

    const totalCount = filteredUsers.length;
    return { data: users, total: totalCount };
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

  async findBusinessAdminsForWhatsApp(businessId: string): Promise<User[]> {
    return this.user.filter(
      (user) =>
        user.businessId === businessId &&
        user.role === "BUSINESS_ADMIN" &&
        user.whatsapp_notifications_enabled &&
        user.whatsapp_phone,
    );
  }

  async findUserByDriverId(driverId: string): Promise<User | null> {
    const findUserByDriverId = this.user.find(
      (user) => user.driverId === driverId,
    );

    return findUserByDriverId || null;
  }

  async updateWhatsAppInstanceStatus(
    userId: string,
    connected: boolean,
  ): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.whatsapp_instance_connected = connected;
    return user;
  }

  async updateEmailNotifications({
    userId,
    email_notifications_enabled,
  }: UpdateEmailNotifications): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.email_notifications_enabled = email_notifications_enabled;
    return user;
  }

  async updateActivityNotifications({
    userId,
    activity_notifications_enabled,
  }: UpdateActivityNotifications): Promise<User | null> {
    const user = this.user.find((user) => user.id === userId);

    if (!user) {
      return null;
    }

    user.activity_notifications_enabled = activity_notifications_enabled;
    return user;
  }

  async findUserWithConnectedWhatsAppByPhone(
    phoneNumber: string,
  ): Promise<User | null> {
    const findUser = this.user.find(
      (user) =>
        user.whatsapp_phone === phoneNumber &&
        user.whatsapp_instance_connected === true,
    );

    return findUser || null;
  }

  async findUserWithWhatsAppByPhone(
    phoneNumber: string,
    excludeUserId?: string,
  ): Promise<User | null> {
    const findUser = this.user.find(
      (user) =>
        user.whatsapp_phone === phoneNumber &&
        (excludeUserId ? user.id !== excludeUserId : true),
    );

    return findUser || null;
  }

  async findAllUsersWithDisconnectedWhatsAppByPhone(
    phoneNumber: string,
    excludeUserId?: string,
  ): Promise<User[]> {
    return this.user.filter(
      (user) =>
        user.whatsapp_phone === phoneNumber &&
        user.whatsapp_instance_connected === false &&
        (excludeUserId ? user.id !== excludeUserId : true),
    );
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
}

export { InMemoryUserRepository };
