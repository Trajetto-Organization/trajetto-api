import { v4 as uuidV4 } from "uuid";
import { IUserRepository } from "../IUser-repository";

import {
  CreateUserProps,
  ListUsers,
  ListUsersByRoleAndBusinessProps,
  UpdateTwoFactorAuthentication,
  UpdateUser,
  UpdateUserName,
  UpdateUserPassword,
  User,
} from "../../dtos/user-dto";

class InMemoryUserRepository implements IUserRepository {
  public user: User[] = [];

  async createUser({
    email,
    password,
    name,
    profileAccessId,
  }: CreateUserProps): Promise<User> {
    const user: User = {
      id: uuidV4(),
      role: "BUSINESS_USER",
      email,
      name,
      password,
      profileAccessId,
      two_factor_enabled: false,
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

    if (isTwoFactorEnabled) {
      user.two_factor_enabled = false;
      return null;
    }

    user.two_factor_enabled = true;
    return user;
  }
}

export { InMemoryUserRepository };
