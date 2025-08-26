import { it, expect, describe, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { UpdateEmailNotificationsUseCase } from "@/modules/user/usecases/update-email-notifications/update-email-notifications-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("Update Email Notifications E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
    });
    userAuthenticated = authData.token;
    originalExecuteMethod = UpdateEmailNotificationsUseCase.prototype.execute;
  });

  afterEach(() => {
    UpdateEmailNotificationsUseCase.prototype.execute = originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should update email notifications successfully", async () => {
    const response = await request(serverInstance)
      .patch("/user/email-notifications")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ notification_enabled: true });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Notificações por e-mail atualizadas com sucesso!",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    UpdateEmailNotificationsUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(async () => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .patch("/user/email-notifications")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ notification_enabled: false });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    UpdateEmailNotificationsUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(async () => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .patch("/user/email-notifications")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ notification_enabled: true });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
