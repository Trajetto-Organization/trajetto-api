import { describe, it, expect, beforeEach, vi } from "vitest";

import { UploadAvatarUseCase } from "@/modules/user/usecases/upload-avatar/upload-avatar-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { UploadService } from "@/shared/services/upload-service";

import { AppError } from "@/shared/errors/AppError";
import { MultipartFile } from "@fastify/multipart";

import fs from "node:fs";
import path from "node:path";

describe("Upload Avatar UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let uploadService: UploadService;

  let uploadAvatarUseCase: UploadAvatarUseCase;

  const tmpDir = path.join(process.cwd(), "tmp");

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    uploadService = new UploadService();

    uploadAvatarUseCase = new UploadAvatarUseCase(userInMemory, uploadService);
  });

  it("should be able to upload an avatar successfully", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    // Create a mock image buffer (1x1 PNG)
    const mockImageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(mockImageBuffer),
      filename: "avatar.png",
      mimetype: "image/png",
    } as any;

    const updatedUser = await uploadAvatarUseCase.execute(user.id, mockFile);

    expect(updatedUser).toHaveProperty("id");
    expect(updatedUser.id).toBe(user.id);

    expect(updatedUser.avatar).toBeTruthy();
    expect(typeof updatedUser.avatar).toBe("string");

    // Verify that the avatar directory was created
    const avatarsDir = path.join(tmpDir, "avatars");
    expect(fs.existsSync(avatarsDir)).toBe(true);

    // Clean up: Delete the uploaded file
    const userFromRepo = await userInMemory.findUserById(user.id);
    if (userFromRepo?.avatar) {
      const filePath = path.join(tmpDir, userFromRepo.avatar);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it("should delete old avatar when uploading a new one", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    // Create a mock image buffer
    const mockImageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(mockImageBuffer),
      filename: "avatar.png",
      mimetype: "image/png",
    } as any;

    // First upload
    await uploadAvatarUseCase.execute(user.id, mockFile);

    // Second upload (should delete the old one)
    const deleteFileSpy = vi.spyOn(uploadService, "deleteFile");
    const updatedUser = await uploadAvatarUseCase.execute(user.id, mockFile);

    expect(deleteFileSpy).toHaveBeenCalledTimes(1);
    expect(updatedUser.avatar).toBeTruthy();

    // Clean up: Delete the uploaded file
    const userFromRepo = await userInMemory.findUserById(user.id);
    if (userFromRepo?.avatar) {
      const filePath = path.join(tmpDir, userFromRepo.avatar);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const mockImageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(mockImageBuffer),
      filename: "avatar.png",
      mimetype: "image/png",
    } as any;

    await expect(
      uploadAvatarUseCase.execute("non-existent-user-id", mockFile),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if file type is not supported", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(Buffer.from("invalid file")),
      filename: "document.pdf",
      mimetype: "application/pdf",
    } as any;

    await expect(
      uploadAvatarUseCase.execute(user.id, mockFile),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("should throw AppError if file is too large", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    // Create a buffer larger than 5MB (assuming that's the limit)
    const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(largeBuffer),
      filename: "large-avatar.png",
      mimetype: "image/png",
    } as any;

    await expect(
      uploadAvatarUseCase.execute(user.id, mockFile),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("should throw AppError if updateAvatar fails", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const mockImageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(mockImageBuffer),
      filename: "avatar.png",
      mimetype: "image/png",
    } as any;

    // Mock updateAvatar to return null
    vi.spyOn(userInMemory, "updateAvatar").mockResolvedValueOnce(null);

    await expect(
      uploadAvatarUseCase.execute(user.id, mockFile),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar atualizar o avatar do usuário! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should handle upload errors gracefully", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const mockImageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(mockImageBuffer),
      filename: "avatar.png",
      mimetype: "image/png",
    } as any;

    // Mock uploadFile to throw an error
    vi.spyOn(uploadService, "uploadFile").mockRejectedValueOnce(
      new Error("Upload failed"),
    );

    await expect(
      uploadAvatarUseCase.execute(user.id, mockFile),
    ).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar fazer upload do avatar! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should create avatars directory if it does not exist", async () => {
    const avatarsDir = path.join(tmpDir, "avatars");

    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const mockImageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(mockImageBuffer),
      filename: "avatar.png",
      mimetype: "image/png",
    } as any;

    await uploadAvatarUseCase.execute(user.id, mockFile);

    // Verify that the avatars directory was created
    expect(fs.existsSync(avatarsDir)).toBe(true);

    // Clean up: Delete the uploaded file
    const userFromRepo = await userInMemory.findUserById(user.id);
    if (userFromRepo?.avatar) {
      const filePath = path.join(tmpDir, userFromRepo.avatar);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it("should process and convert image to webp format", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const mockImageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(mockImageBuffer),
      filename: "avatar.jpg",
      mimetype: "image/jpeg",
    } as any;

    const updatedUser = await uploadAvatarUseCase.execute(user.id, mockFile);

    // Verify that the avatar path contains .webp extension
    expect(updatedUser.avatar).toContain(".webp");

    // Clean up: Delete the uploaded file
    const userFromRepo = await userInMemory.findUserById(user.id);
    if (userFromRepo?.avatar) {
      const filePath = path.join(tmpDir, userFromRepo.avatar);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it("should return full URL for avatar in response", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const mockImageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );

    const mockFile: MultipartFile = {
      toBuffer: vi.fn().mockResolvedValue(mockImageBuffer),
      filename: "avatar.png",
      mimetype: "image/png",
    } as any;

    const updatedUser = await uploadAvatarUseCase.execute(user.id, mockFile);

    // Verify that avatar is a full URL
    expect(updatedUser.avatar).toMatch(/^http/);

    // Clean up: Delete the uploaded file
    const userFromRepo = await userInMemory.findUserById(user.id);
    if (userFromRepo?.avatar) {
      const filePath = path.join(tmpDir, userFromRepo.avatar);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });
});
