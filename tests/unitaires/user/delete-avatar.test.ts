import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import { DeleteAvatarUseCase } from "@/modules/user/usecases/delete-avatar/delete-avatar-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { UploadService } from "@/shared/services/upload-service";

import { AppError } from "@/shared/errors/AppError";

import fs from "node:fs";
import path from "node:path";

describe("Delete Avatar UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let uploadService: UploadService;

  let deleteAvatarUseCase: DeleteAvatarUseCase;

  const tmpDir = path.join(process.cwd(), "tmp");
  const avatarsDir = path.join(tmpDir, "avatars");

  let createdTestFiles: string[] = [];

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    uploadService = new UploadService();

    deleteAvatarUseCase = new DeleteAvatarUseCase(userInMemory, uploadService);
    createdTestFiles = [];
  });

  afterEach(async () => {
    // Clean up only test files created during this test
    for (const file of createdTestFiles) {
      const filePath = path.join(avatarsDir, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    createdTestFiles = [];
  });

  it("should be able to delete an avatar successfully", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    // Manually set an avatar path
    const avatarPath = "avatars/1234567890-avatar-abc123.webp";
    await userInMemory.updateAvatar(user.id, avatarPath);

    // Mock the deleteFile method
    const deleteFileSpy = vi
      .spyOn(uploadService, "deleteFile")
      .mockResolvedValue();

    const updatedUser = await deleteAvatarUseCase.execute(user.id);

    expect(deleteFileSpy).toHaveBeenCalledWith(avatarPath);
    expect(updatedUser.avatar).toBeNull();
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      deleteAvatarUseCase.execute("non-existent-user-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw AppError if user has no avatar to delete", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    await expect(deleteAvatarUseCase.execute(user.id)).rejects.toEqual(
      new AppError("Usuário não possui avatar para ser deletado.", 400),
    );
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

    // Set an avatar path
    const avatarPath = "avatars/1234567890-avatar-abc123.webp";
    await userInMemory.updateAvatar(user.id, avatarPath);

    // Mock deleteFile to succeed
    vi.spyOn(uploadService, "deleteFile").mockResolvedValue();

    // Mock updateAvatar to return null
    vi.spyOn(userInMemory, "updateAvatar").mockResolvedValueOnce(null);

    await expect(deleteAvatarUseCase.execute(user.id)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar deletar o avatar do usuário! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should handle file deletion errors gracefully", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    // Set an avatar path
    const avatarPath = "avatars/1234567890-avatar-abc123.webp";
    await userInMemory.updateAvatar(user.id, avatarPath);

    // Mock deleteFile to throw an error
    vi.spyOn(uploadService, "deleteFile").mockRejectedValueOnce(
      new Error("File deletion failed"),
    );

    await expect(deleteAvatarUseCase.execute(user.id)).rejects.toEqual(
      new AppError(
        "Houve um erro ao tentar deletar o avatar! Por favor, tente novamente.",
        500,
      ),
    );
  });

  it("should delete avatar file from storage", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    // Create a test avatar file in the avatars directory
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }

    const testAvatarFilename = "test-avatar-123.webp";
    const testAvatarPath = path.join(avatarsDir, testAvatarFilename);
    fs.writeFileSync(testAvatarPath, "test content");

    // Track the created file for cleanup
    createdTestFiles.push(testAvatarFilename);

    // Set the avatar path
    const avatarPath = `avatars/${testAvatarFilename}`;
    await userInMemory.updateAvatar(user.id, avatarPath);

    // Verify file exists before deletion
    expect(fs.existsSync(testAvatarPath)).toBe(true);

    await deleteAvatarUseCase.execute(user.id);

    // Verify file was deleted
    expect(fs.existsSync(testAvatarPath)).toBe(false);
  });

  it("should set avatar to null after deletion", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    // Set an avatar path
    const avatarPath = "avatars/1234567890-avatar-abc123.webp";
    await userInMemory.updateAvatar(user.id, avatarPath);

    // Mock deleteFile
    vi.spyOn(uploadService, "deleteFile").mockResolvedValue();

    // Verify user has avatar before deletion
    const userBefore = await userInMemory.findUserById(user.id);
    expect(userBefore?.avatar).toBe(avatarPath);

    // Delete avatar
    const updatedUser = await deleteAvatarUseCase.execute(user.id);

    // Verify avatar is null
    expect(updatedUser.avatar).toBeNull();

    // Verify in repository
    const userAfter = await userInMemory.findUserById(user.id);
    expect(userAfter?.avatar).toBeNull();
  });

  it("should call deleteFile with correct avatar path", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const avatarPath = "avatars/1234567890-test-avatar-xyz.webp";
    await userInMemory.updateAvatar(user.id, avatarPath);

    const deleteFileSpy = vi
      .spyOn(uploadService, "deleteFile")
      .mockResolvedValue();

    await deleteAvatarUseCase.execute(user.id);

    expect(deleteFileSpy).toHaveBeenCalledTimes(1);
    expect(deleteFileSpy).toHaveBeenCalledWith(avatarPath);
  });

  it("should return updated user without avatar", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const avatarPath = "avatars/1234567890-avatar-abc123.webp";
    await userInMemory.updateAvatar(user.id, avatarPath);

    vi.spyOn(uploadService, "deleteFile").mockResolvedValue();

    const updatedUser = await deleteAvatarUseCase.execute(user.id);

    expect(updatedUser).toHaveProperty("id");
    expect(updatedUser.id).toBe(user.id);

    expect(updatedUser.email).toBe(user.email);
    expect(updatedUser.name).toBe(user.name);

    expect(updatedUser.avatar).toBeNull();
  });

  it("should handle AppError instances correctly", async () => {
    const user = await userInMemory.createUser({
      email: "user@example.com",
      password: "password123",
      name: "Test User",
      role: "BUSINESS_USER",
      businessId: "business-1",
      profileAccessId: "profile-1",
    });

    const avatarPath = "avatars/1234567890-avatar-abc123.webp";
    await userInMemory.updateAvatar(user.id, avatarPath);

    // Mock deleteFile to throw an AppError
    const customError = new AppError("Custom error message", 400);
    vi.spyOn(uploadService, "deleteFile").mockRejectedValueOnce(customError);

    await expect(deleteAvatarUseCase.execute(user.id)).rejects.toEqual(
      customError,
    );
  });
});
