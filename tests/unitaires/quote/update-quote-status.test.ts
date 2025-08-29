import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryQuoteRepository } from "@/modules/quote/repositories/in-memory/in-memory-quote-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { UpdateQuoteStatusUseCase } from "@/modules/quote/usecases/update-quote-status/update-quote-status-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { QuoteAccessDeniedError } from "@/modules/quote/usecases/errors/quote-access denied-error";
import { QuoteNotFoundError } from "@/modules/quote/usecases/errors/quote-not-found-error";

import { AppError } from "@/shared/errors/AppError";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Update Quote Status UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let quoteInMemory: InMemoryQuoteRepository;

  let updateQuoteStatus: UpdateQuoteStatusUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    quoteInMemory = new InMemoryQuoteRepository();
    updateQuoteStatus = new UpdateQuoteStatusUseCase(
      userInMemory,
      quoteInMemory,
    );
  });

  it("should be able to update quote status to CONTACTED", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quote = await quoteInMemory.createQuote({
      name: "John Doe Silva",
      company: "Test Company",
      email: "john@test.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    const before = new Date();

    const updatedQuote = await updateQuoteStatus.execute({
      quoteId: quote.id,
      status: "CONTACTED",
      notes: "Customer contacted by phone",
      userId: user.id,
    });

    const after = new Date();

    expect(updatedQuote.id).toBe(quote.id);
    expect(updatedQuote.status).toBe("CONTACTED");
    expect(updatedQuote.notes).toBe("Customer contacted by phone");
    expect(updatedQuote.contacted_at).not.toBeNull();
    expect(
      new Date(updatedQuote.contacted_at as Date).getTime(),
    ).toBeGreaterThanOrEqual(before.getTime());
    expect(
      new Date(updatedQuote.contacted_at as Date).getTime(),
    ).toBeLessThanOrEqual(after.getTime());
    expect(new Date(updatedQuote.updated_at).getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(new Date(updatedQuote.updated_at).getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
  });

  it("should be able to update quote status to CLOSED", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quote = await quoteInMemory.createQuote({
      name: "Jane Smith Costa",
      company: "Another Company",
      email: "jane@company.com",
      telephone: "21888888888",
      fleet_size: "6-15",
    });

    const updatedQuote = await updateQuoteStatus.execute({
      quoteId: quote.id,
      status: "CLOSED",
      notes: "Customer decided not to proceed",
      userId: user.id,
    });

    expect(updatedQuote.status).toBe("CLOSED");
    expect(updatedQuote.notes).toBe("Customer decided not to proceed");
    expect(updatedQuote.contacted_at).not.toBeNull();
  });

  it("should be able to update quote status to CONVERTED", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quote = await quoteInMemory.createQuote({
      name: "Bob Wilson Santos",
      company: "Success Company",
      email: "bob@success.com",
      telephone: "31777777777",
      fleet_size: "16-30",
    });

    const updatedQuote = await updateQuoteStatus.execute({
      quoteId: quote.id,
      status: "CONVERTED",
      notes: "Customer became a client",
      userId: user.id,
    });

    expect(updatedQuote.status).toBe("CONVERTED");
    expect(updatedQuote.notes).toBe("Customer became a client");
    expect(updatedQuote.contacted_at).toBeNull(); // Only CONTACTED and CLOSED set contacted_at
  });

  it("should be able to update quote status to PENDING", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quote = await quoteInMemory.createQuote({
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    // First update to CONTACTED
    await updateQuoteStatus.execute({
      quoteId: quote.id,
      status: "CONTACTED",
      userId: user.id,
    });

    // Then back to PENDING
    const updatedQuote = await updateQuoteStatus.execute({
      quoteId: quote.id,
      status: "PENDING",
      notes: "Reverted to pending status",
      userId: user.id,
    });

    expect(updatedQuote.status).toBe("PENDING");
    expect(updatedQuote.notes).toBe("Reverted to pending status");
    expect(updatedQuote.contacted_at).toBeNull(); // contacted_at not set for PENDING
  });

  it("should be able to update quote status without notes", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quote = await quoteInMemory.createQuote({
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    const updatedQuote = await updateQuoteStatus.execute({
      quoteId: quote.id,
      status: "CONTACTED",
      userId: user.id,
    });

    expect(updatedQuote.status).toBe("CONTACTED");
    expect(updatedQuote.notes).toBeUndefined();
  });

  it("should update contacted_at when status is CONTACTED or CLOSED", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quote1 = await quoteInMemory.createQuote({
      name: "User 1",
      company: "Company 1",
      email: "user1@example.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    const quote2 = await quoteInMemory.createQuote({
      name: "User 2",
      company: "Company 2",
      email: "user2@example.com",
      telephone: "21888888888",
      fleet_size: "6-15",
    });

    // Test CONTACTED status sets contacted_at
    const contactedQuote = await updateQuoteStatus.execute({
      quoteId: quote1.id,
      status: "CONTACTED",
      userId: user.id,
    });

    expect(contactedQuote.contacted_at).not.toBeNull();

    // Test CLOSED status sets contacted_at
    const closedQuote = await updateQuoteStatus.execute({
      quoteId: quote2.id,
      status: "CLOSED",
      userId: user.id,
    });

    expect(closedQuote.contacted_at).not.toBeNull();
  });

  it("should not update contacted_at when status is PENDING or CONVERTED", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quote1 = await quoteInMemory.createQuote({
      name: "User 1",
      company: "Company 1",
      email: "user1@example.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    const quote2 = await quoteInMemory.createQuote({
      name: "User 2",
      company: "Company 2",
      email: "user2@example.com",
      telephone: "21888888888",
      fleet_size: "6-15",
    });

    // Test PENDING status doesn't set contacted_at
    const pendingQuote = await updateQuoteStatus.execute({
      quoteId: quote1.id,
      status: "PENDING",
      userId: user.id,
    });

    expect(pendingQuote.contacted_at).toBeNull();

    // Test CONVERTED status doesn't set contacted_at
    const convertedQuote = await updateQuoteStatus.execute({
      quoteId: quote2.id,
      status: "CONVERTED",
      userId: user.id,
    });

    expect(convertedQuote.contacted_at).toBeNull();
  });

  it("should update all quote statuses correctly", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quote = await quoteInMemory.createQuote({
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    const statuses = ["PENDING", "CONTACTED", "CLOSED", "CONVERTED"] as const;

    for (const status of statuses) {
      const updatedQuote = await updateQuoteStatus.execute({
        quoteId: quote.id,
        status,
        notes: `Updated to ${status}`,
        userId: user.id,
      });

      expect(updatedQuote.status).toBe(status);
      expect(updatedQuote.notes).toBe(`Updated to ${status}`);
    }
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    const quote = await quoteInMemory.createQuote({
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    await expect(
      updateQuoteStatus.execute({
        quoteId: quote.id,
        status: "CONTACTED",
        userId: "non-existing-user-id",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw QuoteAccessDeniedError if user is not MASTER", async () => {
    const nonMasterRoles: UserRole[] = ["BUSINESS_ADMIN", "BUSINESS_USER"];

    const quote = await quoteInMemory.createQuote({
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    for (const role of nonMasterRoles) {
      const userData = {
        email: `${role.toLowerCase()}@example.com`,
        password: "password",
        name: `${role} User`,
        businessId: "business-1",
        profileAccessId: "profile-1",
        role,
      };

      const user = await userInMemory.createUser(userData);

      await expect(
        updateQuoteStatus.execute({
          quoteId: quote.id,
          status: "CONTACTED",
          userId: user.id,
        }),
      ).rejects.toBeInstanceOf(QuoteAccessDeniedError);
    }
  });

  it("should throw QuoteNotFoundError if quote does not exist", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    await expect(
      updateQuoteStatus.execute({
        quoteId: "non-existing-quote-id",
        status: "CONTACTED",
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(QuoteNotFoundError);
  });

  it("should throw AppError if update operation fails", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quote = await quoteInMemory.createQuote({
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    vi.spyOn(quoteInMemory, "updateQuoteStatus").mockRejectedValueOnce(
      new Error("Database connection error"),
    );

    try {
      await updateQuoteStatus.execute({
        quoteId: quote.id,
        status: "CONTACTED",
        userId: user.id,
      });
      expect.fail("Should have thrown an AppError");
    } catch (error: any) {
      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toBe(
        "Houve um erro ao tentar atualizar o status do orçamento! Por favor, tente novamente.",
      );

      expect(error.statusCode).toBe(500);
    }
  });

  it("should preserve original quote data when updating", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const originalQuoteData = {
      name: "John Doe Silva",
      company: "Original Company",
      email: "john@original.com",
      telephone: "11999999999",
      fleet_size: "16-30" as const,
      message: "Original message",
    };

    const quote = await quoteInMemory.createQuote(originalQuoteData);

    const updatedQuote = await updateQuoteStatus.execute({
      quoteId: quote.id,
      status: "CONTACTED",
      notes: "New notes",
      userId: user.id,
    });

    // Check that original data is preserved
    expect(updatedQuote.name).toBe(originalQuoteData.name);
    expect(updatedQuote.company).toBe(originalQuoteData.company);
    expect(updatedQuote.email).toBe(originalQuoteData.email);
    expect(updatedQuote.telephone).toBe(originalQuoteData.telephone);
    expect(updatedQuote.fleet_size).toBe(originalQuoteData.fleet_size);
    expect(updatedQuote.message).toBe(originalQuoteData.message);
    expect(updatedQuote.created_at).toBe(quote.created_at);

    // Check that only status, notes, contacted_at, and updated_at changed
    expect(updatedQuote.status).toBe("CONTACTED");
    expect(updatedQuote.notes).toBe("New notes");
    expect(updatedQuote.contacted_at).not.toBeNull();
    expect(updatedQuote.updated_at).not.toBe(quote.updated_at);
  });
});
