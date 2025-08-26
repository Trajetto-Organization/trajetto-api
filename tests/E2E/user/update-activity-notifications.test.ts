import { it, expect, describe, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";

import { serverInstance, app } from "@/http";
import { createAuthenticateUser } from "utils/tests/create-authenticate-user";

import { UpdateActivityNotificationsUseCase } from "@/modules/user/usecases/update-activity-notifications/update-activity-notifications-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

let userAuthenticated: string;
let originalExecuteMethod: any;

describe("Update Activity Notifications E2E", () => {
  beforeAll(async () => {
    await app.ready();

    const authData = await createAuthenticateUser({
      app: serverInstance,
      userRole: "BUSINESS_USER",
    });

    userAuthenticated = authData.token;
    originalExecuteMethod =
      UpdateActivityNotificationsUseCase.prototype.execute;
  });

  afterEach(() => {
    UpdateActivityNotificationsUseCase.prototype.execute =
      originalExecuteMethod;
    vi.restoreAllMocks();
  });

  it("should update activity notifications successfully", async () => {
    const response = await request(serverInstance)
      .patch("/user/activity-notifications")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ notification_enabled: true });

    expect(response.statusCode).toEqual(200);
    expect(response.body.message).toBe(
      "Notificações de atividade atualizadas com sucesso!",
    );
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    UpdateActivityNotificationsUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(async () => {
        throw new ResourceNotFoundError();
      });

    const response = await request(serverInstance)
      .patch("/user/activity-notifications")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ notification_enabled: false });

    expect(response.statusCode).toEqual(400);
    expect(response.body.message).toBe("Recurso não encontrado!");
  });

  it("should throw Internal server error if an unknown error occurs", async () => {
    UpdateActivityNotificationsUseCase.prototype.execute = vi
      .fn()
      .mockImplementation(async () => {
        throw new Error("Unexpected error");
      });

    const response = await request(serverInstance)
      .patch("/user/activity-notifications")
      .set("Authorization", `Bearer ${userAuthenticated}`)
      .send({ notification_enabled: true });

    expect(response.statusCode).toEqual(500);
    expect(response.body.message).toBe("Internal server error");
  });
});
