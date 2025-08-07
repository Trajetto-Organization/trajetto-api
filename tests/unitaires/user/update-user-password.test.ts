import { expect, it, describe, beforeEach, vi } from "vitest";
import { hash, compare } from "bcrypt";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { UpdateUserPasswordUseCase } from "@/modules/user/usecases/update-user-password/update-user-password-usecase";

import { InMemoryMailProvider } from "@/shared/providers/mail-provider/in-memory/in-memory-mail-provider";

import { UpdateUserPasswordNotMatchError } from "@/modules/user/usecases/errors/update-user-password-not-match-error";
import { UserUpdateIsSamePasswordError } from "@/modules/user/usecases/errors/update-user-is-same-password-error";

import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;
let mailProvider: InMemoryMailProvider;

let updateUserPasswordUseCase: UpdateUserPasswordUseCase;

describe("Update User Password UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    mailProvider = new InMemoryMailProvider();

    updateUserPasswordUseCase = new UpdateUserPasswordUseCase(
      userInMemory,
      mailProvider,
    );
  });

  it("should be able to update user password", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await updateUserPasswordUseCase.execute({
      currentPassword: "password123",
      newPassword: "newpassword@123",
      userId: user.id,
    });

    const updatedUser = await userInMemory.findUserById(user.id);

    expect(updatedUser).toBeDefined();
    expect(
      await compare("newpassword@123", updatedUser?.password as string),
    ).toBeTruthy();
  });

  it("should not be able to update password with wrong id", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    expect(
      async () =>
        await updateUserPasswordUseCase.execute({
          currentPassword: user.password,
          newPassword: "123456789",
          userId: "non-existing-userId",
        }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw UpdateUserPasswordNotMatchError if current password does not match", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await expect(() =>
      updateUserPasswordUseCase.execute({
        currentPassword: "wrongpassword",
        newPassword: "newpassword@123",
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(UpdateUserPasswordNotMatchError);
  });

  it("should throw UserUpdateIsSamePasswordError if new password is the same as current password", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    await expect(() =>
      updateUserPasswordUseCase.execute({
        currentPassword: "password123",
        newPassword: "password123",
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(UserUpdateIsSamePasswordError);
  });

  it("should throw an AppError if an error occurs while updating the password", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    vi.spyOn(userInMemory, "updateUserPassword").mockImplementationOnce(() => {
      throw new Error("Database error");
    });

    await expect(() =>
      updateUserPasswordUseCase.execute({
        currentPassword: "password123",
        newPassword: "newpassword@123",
        userId: user.id,
      }),
    ).rejects.toThrowError(
      new AppError(
        "Não foi possível atualizar a sua senha, por favor tente novamente!",
        500,
      ),
    );
  });
});
