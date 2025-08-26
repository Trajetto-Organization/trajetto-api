import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FastifyReply, FastifyRequest } from "fastify";

import { container } from "tsyringe";

import { notificationContext } from "@/modules/middlewares/notification-context";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { AppError } from "@/shared/errors/AppError";
import { User } from "@/modules/user/dtos/user-dto";

describe("Notification Context Middleware", () => {
  let mockUserRepository: IUserRepository;

  beforeEach(() => {
    mockUserRepository = {
      findUserById: vi.fn(),
    } as any;

    vi.spyOn(container, "resolve").mockReturnValue(mockUserRepository);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create notification context with user preferences", async () => {
    const mockUser: User = {
      id: "user-123",
      name: "Test User",
      email: "test@example.com",
      role: "BUSINESS_USER",
      password: "password",
      businessId: "business-123",
      access_revoked: false,
      email_notifications_enabled: true,
      activity_notifications_enabled: false,
      whatsapp_notifications_enabled: true,
    };

    vi.mocked(mockUserRepository.findUserById).mockResolvedValue(mockUser);

    const request = {
      user: { id: "user-123" },
    } as FastifyRequest;
    const reply = {} as FastifyReply;

    await notificationContext(request, reply);

    expect(request.notificationContext).toEqual({
      userId: "user-123",
      businessId: "business-123",
      preferences: {
        emailEnabled: true,
        activityEnabled: false,
        whatsappEnabled: true,
      },
    });

    expect(mockUserRepository.findUserById).toHaveBeenCalledWith("user-123");
  });

  it("should create notification context without businessId when user has no businessId", async () => {
    const mockUser: User = {
      id: "user-123",
      name: "Test User",
      email: "test@example.com",
      role: "MASTER",
      password: "password",
      businessId: null,
      access_revoked: false,
      email_notifications_enabled: false,
      activity_notifications_enabled: true,
      whatsapp_notifications_enabled: false,
    };

    vi.mocked(mockUserRepository.findUserById).mockResolvedValue(mockUser);

    const request = {
      user: { id: "user-123" },
    } as FastifyRequest;
    const reply = {} as FastifyReply;

    await notificationContext(request, reply);

    expect(request.notificationContext).toEqual({
      userId: "user-123",
      businessId: undefined,
      preferences: {
        emailEnabled: false,
        activityEnabled: true,
        whatsappEnabled: false,
      },
    });
  });

  it("should throw AppError with status 404 if user is not found", async () => {
    vi.mocked(mockUserRepository.findUserById).mockResolvedValue(null);

    const request = {
      user: { id: "non-existent-user" },
    } as FastifyRequest;
    const reply = {} as FastifyReply;

    await expect(notificationContext(request, reply)).rejects.toEqual(
      new AppError("Usuário não encontrado", 404),
    );

    expect(mockUserRepository.findUserById).toHaveBeenCalledWith(
      "non-existent-user",
    );
  });

  it("should handle user with undefined notification preferences", async () => {
    const mockUser: User = {
      id: "user-123",
      name: "Test User",
      email: "test@example.com",
      role: "BUSINESS_ADMIN",
      password: "password",
      businessId: "business-123",
      access_revoked: false,
      // Notification preferences undefined
      email_notifications_enabled: undefined,
      activity_notifications_enabled: undefined,
      whatsapp_notifications_enabled: undefined,
    };

    vi.mocked(mockUserRepository.findUserById).mockResolvedValue(mockUser);

    const request = {
      user: { id: "user-123" },
    } as FastifyRequest;
    const reply = {} as FastifyReply;

    await notificationContext(request, reply);

    expect(request.notificationContext).toEqual({
      userId: "user-123",
      businessId: "business-123",
      preferences: {
        emailEnabled: undefined, // undefined stays undefined
        activityEnabled: undefined, // undefined stays undefined
        whatsappEnabled: undefined, // undefined stays undefined
      },
    });
  });
});
