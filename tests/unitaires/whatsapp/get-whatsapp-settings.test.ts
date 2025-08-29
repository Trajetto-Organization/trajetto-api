import { describe, it, expect, beforeEach, vi } from "vitest";

import { GetWhatsAppSettingsUseCase } from "@/modules/whatsapp/usecases/manage-settings/get-whatsapp-settings-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { AppError } from "@/shared/errors/AppError";

// Mock utils
vi.mock("@/shared/utils/whatsapp-instance-name", () => ({
  generateWhatsAppInstanceName: vi.fn(
    (email: string, businessId: string) =>
      `user-${email.split("@")[0]}-${businessId}`,
  ),
}));

describe("Get WhatsApp Settings UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let whatsAppProviderMock: any;

  let getWhatsAppSettingsUseCase: GetWhatsAppSettingsUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();

    whatsAppProviderMock = {
      getConnectionStatus: vi.fn(),
    };

    getWhatsAppSettingsUseCase = new GetWhatsAppSettingsUseCase(
      userInMemory,
      whatsAppProviderMock,
    );
  });

  it("should be able to get WhatsApp settings for user with enabled WhatsApp and connected instance", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
      whatsapp_instance_connected: false, // Will be updated by the use case
    });

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "connected",
    });

    const result = await getWhatsAppSettingsUseCase.execute(user.id);

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511999999999",
      instanceConnected: true,
      instanceName: "user-user-business-123",
    });

    // Verify that the user's instance status was updated in the database
    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.whatsapp_instance_connected).toBe(true);
  });

  it("should be able to get WhatsApp settings for user with enabled WhatsApp and disconnected instance", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
      whatsapp_instance_connected: true, // Will be updated by the use case
    });

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "disconnected",
    });

    const result = await getWhatsAppSettingsUseCase.execute(user.id);

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511999999999",
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });

    // Verify that the user's instance status was updated in the database
    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.whatsapp_instance_connected).toBe(false);
  });

  it("should be able to get WhatsApp settings for user with disabled WhatsApp", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    const result = await getWhatsAppSettingsUseCase.execute(user.id);

    expect(result).toEqual({
      enabled: false,
      phoneNumber: undefined,
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });

    // Verify that getConnectionStatus was not called since WhatsApp is disabled
    expect(whatsAppProviderMock.getConnectionStatus).not.toHaveBeenCalled();
  });

  it("should be able to get WhatsApp settings for user without phone number", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
    });

    const result = await getWhatsAppSettingsUseCase.execute(user.id);

    expect(result).toEqual({
      enabled: true,
      phoneNumber: undefined,
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });

    // Verify that getConnectionStatus was not called since no phone number is configured
    expect(whatsAppProviderMock.getConnectionStatus).not.toHaveBeenCalled();
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      getWhatsAppSettingsUseCase.execute("non-existent-user-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should handle connection status check error gracefully", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
      whatsapp_instance_connected: true, // Should remain unchanged due to error
    });

    whatsAppProviderMock.getConnectionStatus.mockRejectedValue(
      new Error("Connection check failed"),
    );

    const result = await getWhatsAppSettingsUseCase.execute(user.id);

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511999999999",
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });

    // Verify that the user's instance status was not updated due to error
    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.whatsapp_instance_connected).toBe(true);
  });

  it("should not update database if connection status is the same", async () => {
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

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "connected",
    });

    // Spy on updateWhatsAppInstanceStatus to verify it's not called
    const updateStatusSpy = vi.spyOn(
      userInMemory,
      "updateWhatsAppInstanceStatus",
    );

    const result = await getWhatsAppSettingsUseCase.execute(user.id);

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "5511999999999",
      instanceConnected: true,
      instanceName: "user-user-business-123",
    });

    // Verify that updateWhatsAppInstanceStatus was not called since status didn't change
    expect(updateStatusSpy).not.toHaveBeenCalled();
  });

  it("should throw AppError on unexpected error during execution", async () => {
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

    // Mock an error in generateWhatsAppInstanceName to trigger the main try-catch block
    const { generateWhatsAppInstanceName } = await import(
      "@/shared/utils/whatsapp-instance-name"
    );

    vi.mocked(generateWhatsAppInstanceName).mockImplementationOnce(() => {
      throw new Error("Unexpected error generating instance name");
    });

    await expect(getWhatsAppSettingsUseCase.execute(user.id)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar buscar as configurações do WhatsApp! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should handle users with undefined whatsapp_notifications_enabled", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      // whatsapp_notifications_enabled is not set (undefined)
    });

    const result = await getWhatsAppSettingsUseCase.execute(user.id);

    expect(result).toEqual({
      enabled: false,
      phoneNumber: undefined,
      instanceConnected: false,
      instanceName: "user-user-business-123",
    });
  });
});
