import { describe, it, expect, beforeEach, vi } from "vitest";

import { UpdateWhatsAppSettingsUseCase } from "@/modules/whatsapp/usecases/manage-settings/update-whatsapp-settings-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { WhatsAppNumberRequiredError } from "@/modules/whatsapp/usecases/errors/whatsapp-number-required-error";
import { WhatsAppPhoneUpdateNotAllowedError } from "@/modules/whatsapp/usecases/errors/whatsapp-phone-update-not-allowed-error";

import { WhatsAppPhoneAlreadyInUseError } from "@/modules/whatsapp/usecases/errors/whatsapp-phone-already-in-use-error";
import { WhatsAppBusinessInstanceNotFoundError } from "@/modules/whatsapp/usecases/errors/whatsapp-business-instance-not-found-error";

import { WhatsAppBusinessNotConnected } from "@/modules/whatsapp/usecases/errors/whatsapp-business-not-connected-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { AppError } from "@/shared/errors/AppError";

// Mock env
vi.mock("@/env", () => ({
  env: {
    TRAJETTO_WHATSAPP_INSTANCE_NAME: "trajetto-business-instance",
  },
}));

// Mock utils
vi.mock("@/shared/utils/whatsapp-instance-name", () => ({
  generateWhatsAppInstanceName: vi.fn(
    (email: string, businessId: string) =>
      `user-${email.split("@")[0]}-${businessId}`,
  ),
}));

// Mock WhatsAppWebhookController
vi.mock(
  "@/modules/whatsapp/usecases/webhook/whatsapp-webhook-controller",
  () => ({
    WhatsAppWebhookController: {
      registerUserOperation: vi.fn(),
    },
  }),
);

describe("Update WhatsApp Settings UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let whatsAppProviderMock: any;

  let updateWhatsAppSettingsUseCase: UpdateWhatsAppSettingsUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();

    whatsAppProviderMock = {
      getConnectionStatus: vi.fn(),
      disconnectInstance: vi.fn(),
    };

    updateWhatsAppSettingsUseCase = new UpdateWhatsAppSettingsUseCase(
      userInMemory,
      whatsAppProviderMock,
    );

    // Reset all mocks
    vi.clearAllMocks();
  });

  it("should be able to enable WhatsApp for the first time", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    // Mock business instance is connected, but user instance doesn't exist yet
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValue({ status: "not_exists" }); // User instance (if checked)

    const result = await updateWhatsAppSettingsUseCase.execute({
      userId: user.id,
      enabled: true,
      phoneNumber: "5511999999999",
    });

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511999999999",
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });

    // Verify user was updated in database
    const updatedUser = await userInMemory.findUserById(user.id);

    expect(updatedUser?.whatsapp_notifications_enabled).toBe(true);
    expect(updatedUser?.whatsapp_phone).toBe("5511999999999");
  });

  it("should be able to disable WhatsApp and keep phone number", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
      whatsapp_instance_connected: true,
    });

    whatsAppProviderMock.disconnectInstance.mockResolvedValue();

    const result = await updateWhatsAppSettingsUseCase.execute({
      userId: user.id,
      enabled: false,
    });

    expect(result).toEqual({
      enabled: false,
      phoneNumber: "5511999999999", // Should keep the phone number
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });

    // Verify user was updated in database
    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.whatsapp_notifications_enabled).toBe(false);

    expect(updatedUser?.whatsapp_phone).toBe("5511999999999"); // Should keep the phone
    expect(updatedUser?.whatsapp_instance_connected).toBe(false);
  });

  it("should be able to re-enable WhatsApp with existing connected instance", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
      whatsapp_phone: "5511999999999",
      whatsapp_instance_connected: false,
    });

    // Mock business instance is connected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValueOnce({ status: "connected" }); // User instance

    const result = await updateWhatsAppSettingsUseCase.execute({
      userId: user.id,
      enabled: true,
      phoneNumber: "5511999999999", // Same phone number
    });

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511999999999",
      instanceConnected: true,
      instanceName: "user-user-business-123",
    });

    // Verify user was updated in database
    const updatedUser = await userInMemory.findUserById(user.id);

    expect(updatedUser?.whatsapp_notifications_enabled).toBe(true);
    expect(updatedUser?.whatsapp_instance_connected).toBe(true);
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      updateWhatsAppSettingsUseCase.execute({
        userId: "non-existent-user-id",
        enabled: true,
        phoneNumber: "5511999999999",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw WhatsAppPhoneUpdateNotAllowedError when trying to change phone while enabled and connected", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
    });

    await expect(
      updateWhatsAppSettingsUseCase.execute({
        userId: user.id,
        enabled: true,
        phoneNumber: "5511888888888", // Different phone number
      }),
    ).rejects.toBeInstanceOf(WhatsAppPhoneUpdateNotAllowedError);
  });

  it("should throw WhatsAppNumberRequiredError when enabling without phone number", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    await expect(
      updateWhatsAppSettingsUseCase.execute({
        userId: user.id,
        enabled: true,
        // phoneNumber not provided
      }),
    ).rejects.toBeInstanceOf(WhatsAppNumberRequiredError);
  });

  it("should throw WhatsAppBusinessInstanceNotFoundError if business instance does not exist", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "not_exists",
    });

    await expect(
      updateWhatsAppSettingsUseCase.execute({
        userId: user.id,
        enabled: true,
        phoneNumber: "5511999999999",
      }),
    ).rejects.toBeInstanceOf(WhatsAppBusinessInstanceNotFoundError);
  });

  it("should throw WhatsAppBusinessNotConnected if business instance is not connected", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "disconnected",
    });

    await expect(
      updateWhatsAppSettingsUseCase.execute({
        userId: user.id,
        enabled: true,
        phoneNumber: "5511999999999",
      }),
    ).rejects.toBeInstanceOf(WhatsAppBusinessNotConnected);
  });

  it("should throw WhatsAppBusinessInstanceNotFoundError on 404 error", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    const error404 = new Error("Not found");
    (error404 as any).response = { status: 404 };

    whatsAppProviderMock.getConnectionStatus.mockRejectedValue(error404);

    await expect(
      updateWhatsAppSettingsUseCase.execute({
        userId: user.id,
        enabled: true,
        phoneNumber: "5511999999999",
      }),
    ).rejects.toBeInstanceOf(WhatsAppBusinessInstanceNotFoundError);
  });

  it("should throw WhatsAppPhoneAlreadyInUseError if phone is used by another connected user", async () => {
    const user1 = await userInMemory.createUser({
      email: "user1@example.com",
      password: "password123",
      name: "User 1",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
    });

    const user2 = await userInMemory.createUser({
      email: "user2@example.com",
      password: "password123",
      name: "User 2",
      businessId: "business-123",
      profileAccessId: "profile-2",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    // Mock business instance is connected
    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "connected",
    });

    // Mock that user1 already has this phone connected
    vi.spyOn(
      userInMemory,
      "findUserWithConnectedWhatsAppByPhone",
    ).mockResolvedValue(user1);

    await expect(
      updateWhatsAppSettingsUseCase.execute({
        userId: user2.id,
        enabled: true,
        phoneNumber: "5511999999999",
      }),
    ).rejects.toBeInstanceOf(WhatsAppPhoneAlreadyInUseError);
  });

  it("should allow same user to use same phone number", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
      whatsapp_phone: "5511999999999",
    });

    // Mock business instance is connected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValue({ status: "disconnected" }); // User instance (if checked)

    // Mock that the same user has this phone (should be allowed)
    vi.spyOn(
      userInMemory,
      "findUserWithConnectedWhatsAppByPhone",
    ).mockResolvedValue(user);

    const result = await updateWhatsAppSettingsUseCase.execute({
      userId: user.id,
      enabled: true,
      phoneNumber: "5511999999999",
    });

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511999999999",
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });
  });

  it("should handle business instance check error and continue execution", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    whatsAppProviderMock.getConnectionStatus.mockRejectedValue(
      new Error("Unexpected error"),
    );

    const result = await updateWhatsAppSettingsUseCase.execute({
      userId: user.id,
      enabled: true,
      phoneNumber: "5511999999999",
    });

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511999999999",
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });
  });

  it("should not check business instance when disabling", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
    });

    whatsAppProviderMock.disconnectInstance.mockResolvedValue();

    const result = await updateWhatsAppSettingsUseCase.execute({
      userId: user.id,
      enabled: false,
    });

    expect(result).toEqual({
      enabled: false,
      phoneNumber: "5511999999999",
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });

    // Verify business instance check was not called when disabling
    expect(whatsAppProviderMock.getConnectionStatus).not.toHaveBeenCalled();
  });

  it("should handle user instance connection check error gracefully", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
      whatsapp_phone: "5511999999999",
    });

    // Mock business instance is connected, but user instance check fails
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockRejectedValueOnce(new Error("Instance check failed")); // User instance check fails

    const result = await updateWhatsAppSettingsUseCase.execute({
      userId: user.id,
      enabled: true,
      phoneNumber: "5511999999999",
    });

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511999999999",
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });
  });

  it("should allow phone number change when WhatsApp is disabled and being enabled", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
      whatsapp_phone: "5511999999999", // Old phone number
    });

    // Mock business instance is connected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValue({ status: "disconnected" }); // User instance (if checked)

    const result = await updateWhatsAppSettingsUseCase.execute({
      userId: user.id,
      enabled: true,
      phoneNumber: "5511888888888", // New phone number
    });

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511888888888",
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });

    // Verify user was updated with new phone number
    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.whatsapp_phone).toBe("5511888888888");
  });

  it("should throw AppError on unexpected error during execution", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    // Mock an error in the main try-catch block
    vi.spyOn(userInMemory, "updateWhatsAppSettings").mockRejectedValue(
      new Error("Database error"),
    );

    // Mock business instance is connected
    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "connected",
    });

    await expect(
      updateWhatsAppSettingsUseCase.execute({
        userId: user.id,
        enabled: true,
        phoneNumber: "5511999999999",
      }),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar atualizar as configurações do WhatsApp! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should handle disable with phone number parameter", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: null, // No existing phone
    });

    whatsAppProviderMock.disconnectInstance.mockResolvedValue();

    const result = await updateWhatsAppSettingsUseCase.execute({
      userId: user.id,
      enabled: false,
      phoneNumber: "5511999999999", // Provided in disable request
    });

    expect(result).toEqual({
      enabled: false,
      phoneNumber: "5511999999999",
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });
  });
});
