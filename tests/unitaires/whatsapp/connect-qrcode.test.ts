import { describe, it, expect, beforeEach, vi } from "vitest";

import { ConnectQRCodeUseCase } from "@/modules/whatsapp/usecases/connect-qrcode/connect-qrcode-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { WhatsAppNotConnectedError } from "@/modules/whatsapp/usecases/errors/whatsapp-not-connected-error";
import { WhatsAppNumberNotConfiguredError } from "@/modules/whatsapp/usecases/errors/whatsapp-number-not-configured-error";

import { WhatsAppPhoneAlreadyInUseError } from "@/modules/whatsapp/usecases/errors/whatsapp-phone-already-in-use-error";
import { WhatsAppBusinessInstanceNotFoundError } from "@/modules/whatsapp/usecases/errors/whatsapp-business-instance-not-found-error";

import { WhatsAppAlreadyConnectedError } from "@/modules/whatsapp/usecases/errors/whatsapp-already-connected-error";

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

describe("Connect QRCode UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let whatsAppProviderMock: any;

  let connectQRCodeUseCase: ConnectQRCodeUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();

    whatsAppProviderMock = {
      getConnectionStatus: vi.fn(),
      createInstance: vi.fn(),
      getQRCode: vi.fn(),
    };

    connectQRCodeUseCase = new ConnectQRCodeUseCase(
      userInMemory,
      whatsAppProviderMock,
    );
  });

  it("should be able to generate QR Code for user", async () => {
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

    // Mock business instance is connected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValueOnce({ status: "not_exists" }); // User instance

    whatsAppProviderMock.createInstance.mockResolvedValue({
      success: true,
      message: "Instance created successfully",
    });

    whatsAppProviderMock.getQRCode.mockResolvedValue({
      success: true,
      data: {
        code: "data:image/png;base64,iVBORw0KGgoAAAANSU...",
      },
    });

    const result = await connectQRCodeUseCase.execute(user.id);

    expect(result).toHaveProperty("code");
    expect(result).toHaveProperty("expiresIn", 300);

    expect(result.code).toBe("data:image/png;base64,iVBORw0KGgoAAAANSU...");
  });

  it("should return QR Code if user instance exists but is disconnected", async () => {
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

    // Mock business instance is connected and user instance is disconnected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValueOnce({ status: "disconnected" }); // User instance

    whatsAppProviderMock.getQRCode.mockResolvedValue({
      success: true,
      data: {
        code: "data:image/png;base64,iVBORw0KGgoAAAANSU...",
      },
    });

    const result = await connectQRCodeUseCase.execute(user.id);

    expect(result).toHaveProperty("code");
    expect(result).toHaveProperty("expiresIn", 300);

    expect(whatsAppProviderMock.createInstance).not.toHaveBeenCalled();
  });

  it("should throw ResourceNotFoundError if user is not found", async () => {
    await expect(
      connectQRCodeUseCase.execute("non-existent-user-id"),
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

    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toBeInstanceOf(
      WhatsAppNotConnectedError,
    );
  });

  it("should throw WhatsAppNumberNotConfiguredError if phone number is not configured", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      businessId: "business-123",
      profileAccessId: "profile-1",
      role: "BUSINESS_USER",
      whatsapp_notifications_enabled: true,
    });

    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toBeInstanceOf(
      WhatsAppNumberNotConfiguredError,
    );
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
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "5511999999999",
    });

    // Mock that user1 already has this phone connected
    vi.spyOn(
      userInMemory,
      "findUserWithConnectedWhatsAppByPhone",
    ).mockResolvedValue(user1);

    await expect(connectQRCodeUseCase.execute(user2.id)).rejects.toBeInstanceOf(
      WhatsAppPhoneAlreadyInUseError,
    );
  });

  it("should throw WhatsAppBusinessInstanceNotFoundError if business instance does not exist", async () => {
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

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "not_exists",
    });

    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toBeInstanceOf(
      WhatsAppBusinessInstanceNotFoundError,
    );
  });

  it("should throw AppError if business instance is not connected", async () => {
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

    whatsAppProviderMock.getConnectionStatus.mockResolvedValue({
      status: "disconnected",
    });

    // WhatsAppBusinessNotConnected extends Error (not AppError), so the first catch block
    // does not re-throw it. Execution falls through to the second try block where the
    // user instance status also returns "disconnected", then getQRCode fails,
    // resulting in the generic QR Code error.
    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar gerar o QR Code! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should throw WhatsAppBusinessInstanceNotFoundError on 404 error", async () => {
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

    const error404 = new Error("Not found");
    (error404 as any).response = { status: 404 };

    whatsAppProviderMock.getConnectionStatus.mockRejectedValue(error404);

    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toBeInstanceOf(
      WhatsAppBusinessInstanceNotFoundError,
    );
  });

  it("should throw WhatsAppAlreadyConnectedError if user instance is already connected", async () => {
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

    // Mock business instance is connected and user instance is also connected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValueOnce({ status: "connected" }); // User instance

    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toBeInstanceOf(
      WhatsAppAlreadyConnectedError,
    );
  });

  it("should throw AppError if instance creation fails", async () => {
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

    // Mock business instance is connected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValueOnce({ status: "not_exists" }); // User instance

    whatsAppProviderMock.createInstance.mockResolvedValue({
      success: false,
      message: "Failed to create instance",
    });

    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toEqual(
      new AppError("Erro ao criar instância: Failed to create instance", 500),
    );
  });

  it("should throw AppError if QR Code generation fails", async () => {
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

    // Mock business instance is connected and user instance is disconnected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValueOnce({ status: "disconnected" }); // User instance

    whatsAppProviderMock.getQRCode.mockResolvedValue({
      success: false,
      message: "Failed to generate QR Code",
    });

    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toEqual(
      new AppError("Erro ao gerar QR Code: Failed to generate QR Code", 500),
    );
  });

  it("should throw AppError if QR Code data is missing", async () => {
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

    // Mock business instance is connected and user instance is disconnected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValueOnce({ status: "disconnected" }); // User instance

    whatsAppProviderMock.getQRCode.mockResolvedValue({
      success: true,
      data: null,
    });

    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toEqual(
      new AppError("Erro ao gerar QR Code: undefined", 500),
    );
  });

  it("should throw AppError on unexpected error", async () => {
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

    // Mock business instance is connected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockRejectedValueOnce(new Error("Unexpected error")); // User instance check fails

    await expect(connectQRCodeUseCase.execute(user.id)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar gerar o QR Code! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should allow same user to connect with same phone number", async () => {
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

    // Mock that the same user has this phone (should be allowed)
    vi.spyOn(
      userInMemory,
      "findUserWithConnectedWhatsAppByPhone",
    ).mockResolvedValue(user);

    // Mock business instance is connected
    whatsAppProviderMock.getConnectionStatus
      .mockResolvedValueOnce({ status: "connected" }) // Business instance
      .mockResolvedValueOnce({ status: "disconnected" }); // User instance

    whatsAppProviderMock.getQRCode.mockResolvedValue({
      success: true,
      data: {
        code: "data:image/png;base64,iVBORw0KGgoAAAANSU...",
      },
    });

    const result = await connectQRCodeUseCase.execute(user.id);

    expect(result).toHaveProperty("code");
    expect(result).toHaveProperty("expiresIn", 300);
  });
});
