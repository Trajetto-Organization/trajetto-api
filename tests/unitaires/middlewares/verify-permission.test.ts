import { describe, it, expect, vi, afterEach } from "vitest";
import { FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "@/shared/errors/AppError";
import { UserRole } from "@/modules/user/dtos/user-dto";

import { verifyPermission } from "@/modules/middlewares/verify-permission";
import { PermissionKey } from "@/config/permissions";

interface Permission {
  permissionKey: PermissionKey;
  canRead: boolean;
  canWrite: boolean;
}

interface ProfileAccess {
  permissions: Permission[];
}

interface AuthenticatedUser {
  id: string;
  role: UserRole;
  profileAccess?: ProfileAccess;
}

describe("Verify Permission middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createRequest = (user: Partial<AuthenticatedUser>) =>
    ({
      user: {
        id: "user-id",
        role: "BUSINESS_USER",
        profileAccess: {
          permissions: [],
        },
        ...user,
      },
    }) as FastifyRequest;

  const createReply = () =>
    ({
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    }) as unknown as FastifyReply;

  const runMiddleware = (
    user: Partial<AuthenticatedUser>,
    permissionKey: PermissionKey,
    accessType: "read" | "write",
  ) => {
    const request = createRequest(user);
    const reply = createReply();
    const done = vi.fn();

    const middleware = verifyPermission(permissionKey, accessType);
    middleware(request, reply, done);

    return { request, reply, done };
  };

  it("should allow access for MASTER users", () => {
    const { done } = runMiddleware(
      { role: "MASTER" },
      "profile_access_manage",
      "read",
    );

    expect(done).toHaveBeenCalledWith();
  });

  it("should allow access for BUSINESS_ADMIN users", () => {
    const { done } = runMiddleware(
      { role: "BUSINESS_ADMIN" },
      "profile_access_manage",
      "read",
    );

    expect(done).toHaveBeenCalledWith();
  });

  it("should deny access if BUSINESS_USER has no profileAccess", () => {
    const { done } = runMiddleware(
      { role: "BUSINESS_USER", profileAccess: undefined },
      "profile_access_manage",
      "read",
    );

    expect(done).toHaveBeenCalledWith(
      new AppError("Perfil de acesso não associado ao usuário.", 401),
    );
  });

  it("should deny access if permission is not found", () => {
    const { done } = runMiddleware(
      {
        role: "BUSINESS_USER",
        profileAccess: { permissions: [] },
      },
      "profile_access_manage",
      "read",
    );

    expect(done).toHaveBeenCalledWith(
      new AppError("Permissão não encontrada.", 403),
    );
  });

  it("should deny write access if canWrite is false", () => {
    const { done } = runMiddleware(
      {
        role: "BUSINESS_USER",
        profileAccess: {
          permissions: [
            {
              permissionKey: "profile_access_manage",
              canRead: true,
              canWrite: false,
            },
          ],
        },
      },
      "profile_access_manage",
      "write",
    );
    expect(done).toHaveBeenCalledWith(
      new AppError(
        "Usuário não possui permissão para executar esta ação.",
        403,
      ),
    );
  });

  it("should deny read access if canRead is false", () => {
    const { done } = runMiddleware(
      {
        role: "BUSINESS_USER",
        profileAccess: {
          permissions: [
            {
              permissionKey: "profile_access_manage",
              canRead: false,
              canWrite: true,
            },
          ],
        },
      },
      "profile_access_manage",
      "read",
    );
    expect(done).toHaveBeenCalledWith(
      new AppError(
        "Usuário não possui permissão para visualizar este conteúdo.",
        403,
      ),
    );
  });

  it("should allow read access if canRead is true", () => {
    const { done } = runMiddleware(
      {
        role: "BUSINESS_USER",
        profileAccess: {
          permissions: [
            {
              permissionKey: "profile_access_manage",
              canRead: true,
              canWrite: false,
            },
          ],
        },
      },
      "profile_access_manage",
      "read",
    );
    expect(done).toHaveBeenCalledWith();
  });

  it("should allow write access if canWrite is true", () => {
    const { done } = runMiddleware(
      {
        role: "BUSINESS_USER",
        profileAccess: {
          permissions: [
            {
              permissionKey: "profile_access_manage",
              canRead: false,
              canWrite: true,
            },
          ],
        },
      },
      "profile_access_manage",
      "write",
    );
    expect(done).toHaveBeenCalledWith();
  });
});
