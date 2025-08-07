import { expect, it, describe, beforeEach } from "vitest";
import { hash } from "bcrypt";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { GetUserUseCase } from "@/modules/user/usecases/get-user/get-user-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

let userInMemory: InMemoryUserRepository;
let getUser: GetUserUseCase;

describe("Get User UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    getUser = new GetUserUseCase(userInMemory);
  });

  it("should be able to get user", async () => {
    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const createdUser = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const user = await getUser.execute(createdUser?.id as string);

    expect(user?.id).toEqual(expect.any(String));
    expect(user?.email).toEqual("user@example.com");
  });

  it("should not be able to get user with wrong id", async () => {
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
      async () => await getUser.execute("non-existing-userId"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
