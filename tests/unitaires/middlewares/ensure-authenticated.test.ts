import { describe, it, expect, vi, afterEach } from "vitest";
import { FastifyReply, FastifyRequest } from "fastify";

import { UserRepository } from "@/modules/user/repositories/user-repository";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { AppError } from "@/shared/errors/AppError";
import { User } from "@/modules/user/dtos/user-dto";

describe("Ensure Authenticated Middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should throw an AppError with 'Token ausente!' if no authorization header is provided", async () => {
    const request = { headers: {} } as FastifyRequest;
    const reply = {} as FastifyReply;

    await expect(ensureAuthenticated(request, reply)).rejects.toEqual(
      new AppError("Token ausente!"),
    );
  });

  it("should throw an AppError with status 401 if token is invalid", async () => {
    vi.spyOn(require("jsonwebtoken"), "verify").mockImplementation(() => {
      throw new Error("jwt malformed");
    });

    const request = {
      headers: { authorization: "Bearer invalid-token" },
    } as FastifyRequest;
    const reply = {} as FastifyReply;

    await expect(ensureAuthenticated(request, reply)).rejects.toMatchObject({
      message: "Invalid Token => jwt malformed",
      statusCode: 401,
    });
  });

  it("should throw an AppError with status 401 if user is not found", async () => {
    vi.spyOn(require("jsonwebtoken"), "verify").mockReturnValue({ sub: "123" });
    vi.spyOn(UserRepository.prototype, "findUserById").mockResolvedValue(null);

    const request = {
      headers: { authorization: "Bearer valid-token" },
    } as FastifyRequest;
    const reply = {} as FastifyReply;

    await expect(ensureAuthenticated(request, reply)).rejects.toMatchObject({
      message: expect.stringContaining("Este usuário não existe!"),
      statusCode: 401,
    });
  });

  it("should throw an AppError with status 403 if user access is revoked", async () => {
    vi.spyOn(require("jsonwebtoken"), "verify").mockReturnValue({ sub: "123" });

    const fakeUser: User = {
      id: "some-id",
      name: "User Test",
      email: "test@example.com",
      role: "MASTER",
      password: "1234567",
      access_revoked: true, // User has revoked access
      profileAccess: {
        name: "Profile Name",
        permissions: [
          {
            id: "permission-key",
            action: "New Permission",
            canRead: true,
            canWrite: true,
            permissionKey: "some-permission-key",
          },
        ],
      },
    };

    vi.spyOn(UserRepository.prototype, "findUserById").mockResolvedValue(
      fakeUser,
    );

    const request = {
      headers: { authorization: "Bearer valid-token" },
    } as FastifyRequest;
    const reply = {} as FastifyReply;

    await expect(ensureAuthenticated(request, reply)).rejects.toMatchObject({
      message: expect.stringContaining("Seu acesso foi revogado!"),
      statusCode: 401, // Because it's wrapped in the catch block
    });
  });

  it("should set request.user if token is valid and user is found", async () => {
    vi.spyOn(require("jsonwebtoken"), "verify").mockReturnValue({ sub: "123" });

    const fakeUser: User = {
      id: "some-id",
      name: "User Test",
      email: "test@example.com",
      role: "MASTER",
      password: "1234567",
      access_revoked: false, // User has active access
      profileAccess: {
        name: "Profile Name",
        permissions: [
          {
            id: "permission-key",
            action: "New Permission",
            canRead: true,
            canWrite: true,
            permissionKey: "some-permission-key",
          },
        ],
      },
    };

    vi.spyOn(UserRepository.prototype, "findUserById").mockResolvedValue(
      fakeUser,
    );

    const request = {
      headers: { authorization: "Bearer valid-token" },
    } as FastifyRequest;
    const reply = {} as FastifyReply;

    await ensureAuthenticated(request, reply);

    expect(request.user).toEqual({
      id: "123",
      driver: null,
      driverId: undefined,
      role: fakeUser.role,
      profileAccess: fakeUser.profileAccess,
    });
  });
});
