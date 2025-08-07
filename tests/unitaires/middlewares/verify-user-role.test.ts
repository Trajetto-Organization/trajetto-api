import { describe, it, expect, vi } from "vitest";
import { FastifyReply, FastifyRequest } from "fastify";

import { verifyUserRole } from "@/modules/middlewares/verify-user-role";
import { AppError } from "@/shared/errors/AppError";

import { UserRole } from "@/modules/user/dtos/user-dto";

describe("Verify UserRole Middleware", () => {
  it("should call done() without error if the user role is allowed", () => {
    const allowedRoles: UserRole[] = ["MASTER", "BUSINESS_ADMIN"];
    const middleware = verifyUserRole(allowedRoles);

    const request = {
      user: { role: "MASTER" },
    } as FastifyRequest;

    const reply = {} as FastifyReply;
    const done = vi.fn();

    middleware(request, reply, done);
    expect(done).toHaveBeenCalledWith();
  });

  it("should call done() with error if the user role is missing", () => {
    const allowedRoles: UserRole[] = ["MASTER", "BUSINESS_ADMIN"];
    const middleware = verifyUserRole(allowedRoles);

    const request = {
      user: {},
    } as FastifyRequest;

    const reply = {} as FastifyReply;
    const done = vi.fn();

    middleware(request, reply, done);

    expect(done).toHaveBeenCalled();
    const errorArg = done.mock.calls[0][0];

    expect(errorArg).toBeInstanceOf(AppError);
    expect(errorArg.message).toBe("Usuário não autorizado!");

    expect(errorArg.statusCode).toBe(401);
  });

  it("should call done() with error if the user role is not allowed", () => {
    const allowedRoles: UserRole[] = ["MASTER", "BUSINESS_ADMIN"];
    const middleware = verifyUserRole(allowedRoles);

    const request = {
      user: { role: "BUSINESS_USER" },
    } as FastifyRequest;

    const reply = {} as FastifyReply;
    const done = vi.fn();

    middleware(request, reply, done);

    expect(done).toHaveBeenCalled();
    const errorArg = done.mock.calls[0][0];

    expect(errorArg).toBeInstanceOf(AppError);
    expect(errorArg.message).toBe("Usuário não autorizado!");

    expect(errorArg.statusCode).toBe(401);
  });
});
