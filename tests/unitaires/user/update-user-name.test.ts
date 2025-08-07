import { expect, it, describe, beforeEach, vi } from "vitest";
import { hash } from "bcrypt";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { UpdateUserNameUseCase } from "@/modules/user/usecases/update-user-name/update-user-name-usecase";

import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;
let updateUserNameUseCase: UpdateUserNameUseCase;

describe("Update Username UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    updateUserNameUseCase = new UpdateUserNameUseCase(userInMemory);
  });

  it("should be able to update username", async () => {
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

    await updateUserNameUseCase.execute({
      name: "New Name",
      userId: user.id,
    });

    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.name).toBe("New Name");
  });

  it("should not be able to update username with wrong id", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    expect(
      async () =>
        await updateUserNameUseCase.execute({
          name: "test example",
          userId: "non-existing-userId",
        }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if updating username fails", async () => {
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

    vi.spyOn(userInMemory, "updateUserName").mockImplementationOnce(() => {
      throw new Error("Mocked update error");
    });

    await expect(
      updateUserNameUseCase.execute({
        name: "New Name",
        userId: user.id,
      }),
    ).rejects.toThrowError(
      new AppError(
        "Não foi possível atualizar o seu nome de usuário! Por favor, tente novamente.",
        500,
      ),
    );
  });
});
