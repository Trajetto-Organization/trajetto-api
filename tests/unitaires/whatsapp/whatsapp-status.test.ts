import { describe, it, expect, beforeEach, vi } from "vitest";

import { WhatsAppStatusUseCase } from "@/modules/whatsapp/usecases/whatsapp-status/whatsapp-status-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { WhatsAppNotConnectedError } from "@/modules/whatsapp/usecases/errors/whatsapp-not-connected-error";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

// Mock utils
vi.mock("@/shared/utils/whatsapp-instance-name", () => ({
  generateWhatsAppInstanceName: vi.fn(
    (email: string, businessId: string) =>
      `user-${email.split("@")[0]}-${businessId}`,
  ),
}));

describe("WhatsApp Status UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let whatsAppProviderMock: any;

  let whatsAppStatusUseCase: WhatsAppStatusUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();

    whatsAppProviderMock = {
      getConnectionStatus: vi.fn(),
    };

    whatsAppStatusUseCase = new WhatsAppStatusUseCase(
      userInMemory,
      whatsAppProviderMock,
    );

    // Reset all mocks
    vi.clearAllMocks();
  });

  it("should be able to get connection status for connected instance", async () => {
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

    const result = await whatsAppStatusUseCase.execute(user.id);

    expect(result).toEqual({
      instanceName: "user-user-business-123",
      status: "connected",
      phoneNumber: "5511999999999",
      qrCodeAvailable: false,
      pairingCodeAvailable: false,
    });

    // Verify that the user's instance status was updated in the database
    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.whatsapp_instance_connected).toBe(true);
  });

  it("should be able to get connection status for disconnected instance", async () => {
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

    const result = await whatsAppStatusUseCase.execute(user.id);

    expect(result).toEqual({
      instanceName: "user-user-business-123",
      status: "disconnected",
      phoneNumber: "5511999999999",
      qrCodeAvailable: true,
      pairingCodeAvailable: false,
    });

    // Verify that the user's instance status was updated in the database
    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.whatsapp_instance_connected).toBe(false);
  });

  it("should be able to get connection status for connecting instance", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
      whatsapp_instance_connected: false,
    });

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "connecting",
    });

    const result = await whatsAppStatusUseCase.execute(user.id);

    expect(result).toEqual({
      instanceName: "user-user-business-123",
      status: "connecting",
      phoneNumber: "5511999999999",
      qrCodeAvailable: false,
      pairingCodeAvailable: false,
    });

    // Verify that the user's instance status remains false for connecting status
    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.whatsapp_instance_connected).toBe(false);
  });

  it("should be able to get connection status for user without phone number", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_instance_connected: false,
    });

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "not_exists",
    });

    const result = await whatsAppStatusUseCase.execute(user.id);

    expect(result).toEqual({
      instanceName: "user-user-business-123",
      status: "not_exists",
      phoneNumber: undefined,
      qrCodeAvailable: false,
      pairingCodeAvailable: false,
    });
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      whatsAppStatusUseCase.execute("non-existent-user-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw WhatsAppNotConnectedError if WhatsApp is not enabled", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: false,
    });

    await expect(whatsAppStatusUseCase.execute(user.id)).rejects.toBeInstanceOf(
      WhatsAppNotConnectedError,
    );
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

    const result = await whatsAppStatusUseCase.execute(user.id);

    expect(result).toEqual({
      instanceName: "user-user-business-123",
      status: "connected",
      phoneNumber: "5511999999999",
      qrCodeAvailable: false,
      pairingCodeAvailable: false,
    });

    // Verify that updateWhatsAppInstanceStatus was not called since status didn't change
    expect(updateStatusSpy).not.toHaveBeenCalled();
  });

  it("should return not_exists status and update database on error", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
      whatsapp_instance_connected: true, // Will be updated to false due to error
    });

    whatsAppProviderMock.getConnectionStatus.mockRejectedValue(
      new Error("Instance not found"),
    );

    const result = await whatsAppStatusUseCase.execute(user.id);

    expect(result).toEqual({
      instanceName: "user-user-business-123",
      status: "not_exists",
      phoneNumber: "5511999999999",
      qrCodeAvailable: true,
      pairingCodeAvailable: false,
    });

    // Verify that the user's instance status was updated to false due to error
    const updatedUser = await userInMemory.findUserById(user.id);
    expect(updatedUser?.whatsapp_instance_connected).toBe(false);
  });

  it("should handle different connection statuses correctly", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
      whatsapp_instance_connected: false,
    });

    // Test different statuses and their corresponding qrCodeAvailable values
    const statusTests = [
      { status: "connected", qrCodeAvailable: false, instanceConnected: true },
      {
        status: "disconnected",
        qrCodeAvailable: true,
        instanceConnected: false,
      },
      {
        status: "connecting",
        qrCodeAvailable: false,
        instanceConnected: false,
      },
      {
        status: "not_exists",
        qrCodeAvailable: false,
        instanceConnected: false,
      },
    ];

    for (const test of statusTests) {
      whatsAppProviderMock.getConnectionStatus.mockResolvedValueOnce({
        status: test.status,
      });

      const result = await whatsAppStatusUseCase.execute(user.id);

      expect(result).toEqual({
        instanceName: "user-user-business-123",
        status: test.status,
        phoneNumber: "5511999999999",
        qrCodeAvailable: test.qrCodeAvailable,
        pairingCodeAvailable: false,
      });

      // Verify database status update
      const updatedUser = await userInMemory.findUserById(user.id);
      expect(updatedUser?.whatsapp_instance_connected).toBe(
        test.instanceConnected,
      );
    }
  });

  it("should handle database update error gracefully", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
      whatsapp_instance_connected: false,
    });

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "connected",
    });

    // Mock database update failure
    vi.spyOn(userInMemory, "updateWhatsAppInstanceStatus").mockRejectedValue(
      new Error("Database update failed"),
    );

    // Should still return the correct result despite database update failure
    const result = await whatsAppStatusUseCase.execute(user.id);

    expect(result).toEqual({
      instanceName: "user-user-business-123",
      status: "connected",
      phoneNumber: "5511999999999",
      qrCodeAvailable: false,
      pairingCodeAvailable: false,
    });
  });

  it("should handle WhatsApp enabled but with null value", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: null as any, // Null value
    });

    await expect(whatsAppStatusUseCase.execute(user.id)).rejects.toBeInstanceOf(
      WhatsAppNotConnectedError,
    );
  });

  it("should handle user with different businessId formats", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "different-business-456",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
    });

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "connected",
    });

    const result = await whatsAppStatusUseCase.execute(user.id);

    expect(result).toEqual({
      instanceName: "user-user-different-business-456",
      status: "connected",
      phoneNumber: "5511999999999",
      qrCodeAvailable: false,
      pairingCodeAvailable: false,
    });
  });
});
