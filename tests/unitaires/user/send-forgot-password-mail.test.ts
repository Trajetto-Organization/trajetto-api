import { beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "bcrypt";

import { v4 as uuidV4 } from "uuid";

import { SendForgotPasswordMailUseCase } from "@/modules/user/usecases/send-forgot-password-mail/send-forgot-password-mail-usecase";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { EmailNotFoundError } from "@/modules/user/usecases/errors/email-not-found-error";

import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";

import { AppError } from "@/shared/errors/AppError";

let userInMemory: InMemoryUserRepository;

let usersTokensInMemory: InMemoryUserTokensRepository;
let sendForgotPasswordMailUseCase: SendForgotPasswordMailUseCase;

describe("Send Forgot Password Mail UseCase", () => {
  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    usersTokensInMemory = new InMemoryUserTokensRepository();

    sendForgotPasswordMailUseCase = new SendForgotPasswordMailUseCase(
      userInMemory,
      usersTokensInMemory,
    );
  });

  it("should be able to send a forgot password mail to user", async () => {
    const enqueueEmailSpy = vi.spyOn(
      sendForgotPasswordMailUseCase["emailQueue"],
      "enqueueEmail",
    );

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

    await sendForgotPasswordMailUseCase.execute("user@example.com");
    expect(enqueueEmailSpy).toHaveBeenCalled();
  });

  it("should be able to send a forgot password mail to user if token exists", async () => {
    const enqueueEmailSpy = vi.spyOn(
      sendForgotPasswordMailUseCase["emailQueue"],
      "enqueueEmail",
    );

    const password = "password123";
    const hashedPassword = await hash(password, 6);

    const userCreated = await userInMemory.createUser({
      email: "user@example.com",
      password: hashedPassword,
      name: "John Doe",
      businessId: "some-business-id",
      profileAccessId: "some-profile-id",
      role: "MASTER",
    });

    const expires = new Date(new Date().getTime() + 3600 * 1000); // 1 hour in milliseconds
    const token = uuidV4();

    await usersTokensInMemory.createForgotPasswordVerificationToken({
      email: userCreated.email,
      expires,
      token,
    });

    await sendForgotPasswordMailUseCase.execute("user@example.com");
    expect(enqueueEmailSpy).toHaveBeenCalled();
  });

  it("should not be able to send an e-mail if user does not exists", async () => {
    await expect(
      sendForgotPasswordMailUseCase.execute("non-existing-e-mail"),
    ).rejects.toBeInstanceOf(EmailNotFoundError);
  });

  it("should be able to create an users token", async () => {
    const generateTokenMailSpy = vi.spyOn(
      usersTokensInMemory,
      "createForgotPasswordVerificationToken",
    );

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

    await sendForgotPasswordMailUseCase.execute("user@example.com");
    expect(generateTokenMailSpy).toBeCalled();
  });

  it("should throw an AppError if token creation fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    vi.spyOn(
      usersTokensInMemory,
      "createForgotPasswordVerificationToken",
    ).mockRejectedValueOnce(new Error("Token creation failed"));

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

    await expect(
      sendForgotPasswordMailUseCase.execute("user@example.com"),
    ).rejects.toThrowError(
      new AppError(
        "Houve um erro ao tentar enviar o e-mail correspondente a um endereço cadastrado! Por favor, tente novamente.",
      ),
    );

    consoleErrorSpy.mockRestore();
  });
});
