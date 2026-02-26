import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryQuoteRepository } from "@/modules/quote/repositories/in-memory/in-memory-quote-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { DeleteQuoteUseCase } from "@/modules/quote/usecases/delete-quote/delete-quote-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { QuoteAccessDeniedError } from "@/modules/quote/usecases/errors/quote-access denied-error";
import { QuoteNotFoundError } from "@/modules/quote/usecases/errors/quote-not-found-error";

import { AppError } from "@/shared/errors/AppError";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("Delete Quote UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let quoteInMemory: InMemoryQuoteRepository;

  let deleteQuote: DeleteQuoteUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    quoteInMemory = new InMemoryQuoteRepository();

    deleteQuote = new DeleteQuoteUseCase(userInMemory, quoteInMemory);
  });

  it("should be able to delete a quote", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quoteData = {
      name: "John Doe Silva",
      company: "Test Company LTDA",
      email: "john@test.com",
      telephone: "11999999999",
      fleet_size: "1-5" as const,
      message: "Need quote for fleet management",
    };

    const createdQuote = await quoteInMemory.createQuote(quoteData);

    const deletedQuote = await deleteQuote.execute(createdQuote.id, user.id);

    expect(deletedQuote).toHaveProperty("id");
    expect(deletedQuote.id).toBe(createdQuote.id);
    expect(deletedQuote.name).toBe(quoteData.name);
    expect(deletedQuote.company).toBe(quoteData.company);
    expect(deletedQuote.email).toBe(quoteData.email);
    expect(deletedQuote.telephone).toBe(quoteData.telephone);
    expect(deletedQuote.fleet_size).toBe(quoteData.fleet_size);
    expect(deletedQuote.message).toBe(quoteData.message);

    // Verify quote was actually removed from repository
    const quoteExists = await quoteInMemory.findQuoteById(createdQuote.id);
    expect(quoteExists).toBeNull();
  });

  it("should be able to delete quotes with different statuses", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const statuses = ["PENDING", "CONTACTED", "CLOSED", "CONVERTED"] as const;

    for (const status of statuses) {
      const quote = await quoteInMemory.createQuote({
        name: `User ${status}`,
        company: `Company ${status}`,
        email: `${status.toLowerCase()}@example.com`,
        telephone: "11999999999",
        fleet_size: "1-5",
      });

      // Update status if not PENDING
      if (status !== "PENDING") {
        await quoteInMemory.updateQuoteStatus({
          quoteId: quote.id,
          quoteData: { status },
        });
      }

      const deletedQuote = await deleteQuote.execute(quote.id, user.id);

      expect(deletedQuote.status).toBe(status);
      expect(deletedQuote.name).toBe(`User ${status}`);

      // Verify quote was removed
      const quoteExists = await quoteInMemory.findQuoteById(quote.id);
      expect(quoteExists).toBeNull();
    }
  });

  it("should be able to delete quote with notes and contacted_at", async () => {
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
      company: "Test Company",
      email: "jane@test.com",
      telephone: "21888888888",
      fleet_size: "6-15",
    });

    // Update quote with notes
    await quoteInMemory.updateQuoteStatus({
      quoteId: quote.id,
      quoteData: {
        status: "CONTACTED",
        notes: "Customer was contacted by phone",
      },
    });

    const deletedQuote = await deleteQuote.execute(quote.id, user.id);

    expect(deletedQuote.status).toBe("CONTACTED");
    expect(deletedQuote.notes).toBe("Customer was contacted by phone");
    expect(deletedQuote.contacted_at).not.toBeNull();

    // Verify quote was removed
    const quoteExists = await quoteInMemory.findQuoteById(quote.id);
    expect(quoteExists).toBeNull();
  });

  it("should be able to delete quote without message", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quoteData = {
      name: "Bob Wilson Santos",
      company: "Another Company",
      email: "bob@another.com",
      telephone: "31777777777",
      fleet_size: "16-30" as const,
    };

    const createdQuote = await quoteInMemory.createQuote(quoteData);

    const deletedQuote = await deleteQuote.execute(createdQuote.id, user.id);

    expect(deletedQuote.message).toBeNull();
    expect(deletedQuote.name).toBe(quoteData.name);
    expect(deletedQuote.company).toBe(quoteData.company);

    // Verify quote was removed
    const quoteExists = await quoteInMemory.findQuoteById(createdQuote.id);
    expect(quoteExists).toBeNull();
  });

  it("should delete quote and maintain repository integrity", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create multiple quotes
    const quote1 = await quoteInMemory.createQuote({
      name: "User One",
      company: "Company 1",
      email: "user1@example.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    const quote2 = await quoteInMemory.createQuote({
      name: "User Two",
      company: "Company 2",
      email: "user2@example.com",
      telephone: "21888888888",
      fleet_size: "6-15",
    });

    const quote3 = await quoteInMemory.createQuote({
      name: "User Three",
      company: "Company 3",
      email: "user3@example.com",
      telephone: "31777777777",
      fleet_size: "16-30",
    });

    // Delete the middle quote
    const deletedQuote = await deleteQuote.execute(quote2.id, user.id);

    expect(deletedQuote.id).toBe(quote2.id);

    // Verify only quote2 was removed
    const quote1Exists = await quoteInMemory.findQuoteById(quote1.id);
    const quote2Exists = await quoteInMemory.findQuoteById(quote2.id);
    const quote3Exists = await quoteInMemory.findQuoteById(quote3.id);

    expect(quote1Exists).not.toBeNull();
    expect(quote2Exists).toBeNull();
    expect(quote3Exists).not.toBeNull();

    // Verify repository count
    const allQuotes = await quoteInMemory.listQuotes({ page: 1, pageSize: 10 });
    expect(allQuotes.total).toBe(2);
    expect(allQuotes.data).toHaveLength(2);
  });

  it("should return the complete deleted quote object", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quoteData = {
      name: "Complete Test User",
      company: "Complete Test Company",
      email: "complete@test.com",
      telephone: "11987654321",
      fleet_size: "31-50" as const,
      message: "Complete test message for deletion",
    };

    const createdQuote = await quoteInMemory.createQuote(quoteData);

    const deletedQuote = await deleteQuote.execute(createdQuote.id, user.id);

    // Verify all properties are returned
    expect(deletedQuote).toHaveProperty("id");
    expect(deletedQuote).toHaveProperty("name");
    expect(deletedQuote).toHaveProperty("company");
    expect(deletedQuote).toHaveProperty("email");
    expect(deletedQuote).toHaveProperty("telephone");
    expect(deletedQuote).toHaveProperty("fleet_size");
    expect(deletedQuote).toHaveProperty("message");
    expect(deletedQuote).toHaveProperty("status");
    expect(deletedQuote).toHaveProperty("contacted_at");
    expect(deletedQuote).toHaveProperty("notes");
    expect(deletedQuote).toHaveProperty("created_at");
    expect(deletedQuote).toHaveProperty("updated_at");

    expect(deletedQuote.id).toBe(createdQuote.id);
    expect(deletedQuote.name).toBe(quoteData.name);
    expect(deletedQuote.company).toBe(quoteData.company);
    expect(deletedQuote.email).toBe(quoteData.email);
    expect(deletedQuote.telephone).toBe(quoteData.telephone);
    expect(deletedQuote.fleet_size).toBe(quoteData.fleet_size);
    expect(deletedQuote.message).toBe(quoteData.message);
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
      deleteQuote.execute(quote.id, "non-existing-user-id"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    // Verify quote still exists after failed deletion
    const quoteExists = await quoteInMemory.findQuoteById(quote.id);
    expect(quoteExists).not.toBeNull();
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
        deleteQuote.execute(quote.id, user.id),
      ).rejects.toBeInstanceOf(QuoteAccessDeniedError);

      // Verify quote still exists after failed deletion
      const quoteExists = await quoteInMemory.findQuoteById(quote.id);
      expect(quoteExists).not.toBeNull();
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
      deleteQuote.execute("non-existing-quote-id", user.id),
    ).rejects.toBeInstanceOf(QuoteNotFoundError);
  });

  it("should throw AppError if delete operation fails", async () => {
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

    vi.spyOn(quoteInMemory, "deleteQuote").mockRejectedValueOnce(
      new Error("Database connection error"),
    );

    try {
      await deleteQuote.execute(quote.id, user.id);
      expect.fail("Should have thrown an AppError");
    } catch (error: any) {
      expect(error).toBeInstanceOf(AppError);

      expect(error.message).toBe("Erro ao deletar orçamento");
      expect(error.statusCode).toBe(500);
    }

    // Verify quote still exists after failed deletion (restore mock)
    vi.restoreAllMocks();
    const quoteExists = await quoteInMemory.findQuoteById(quote.id);
    expect(quoteExists).not.toBeNull();
  });

  it("should handle deletion of quotes with all fleet sizes", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const fleetSizes = [
      "1-5",
      "6-15",
      "16-30",
      "31-50",
      "51-100",
      "101+",
    ] as const;

    for (const fleetSize of fleetSizes) {
      const quote = await quoteInMemory.createQuote({
        name: `User ${fleetSize}`,
        company: `Company ${fleetSize}`,
        email: `user${fleetSize}@example.com`,
        telephone: "11999999999",
        fleet_size: fleetSize,
      });

      const deletedQuote = await deleteQuote.execute(quote.id, user.id);

      expect(deletedQuote.fleet_size).toBe(fleetSize);
      expect(deletedQuote.name).toBe(`User ${fleetSize}`);

      // Verify quote was removed
      const quoteExists = await quoteInMemory.findQuoteById(quote.id);
      expect(quoteExists).toBeNull();
    }
  });

  it("should execute deletion flow correctly", async () => {
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
      name: "Flow Test User",
      company: "Flow Test Company",
      email: "flow@test.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    // Spy on repository methods to verify execution flow
    const findUserSpy = vi.spyOn(userInMemory, "findUserById");
    const findQuoteSpy = vi.spyOn(quoteInMemory, "findQuoteById");
    const deleteQuoteSpy = vi.spyOn(quoteInMemory, "deleteQuote");

    const deletedQuote = await deleteQuote.execute(quote.id, user.id);

    // Verify execution flow
    expect(findUserSpy).toHaveBeenCalledWith(user.id);
    expect(findQuoteSpy).toHaveBeenCalledWith(quote.id);
    expect(deleteQuoteSpy).toHaveBeenCalledWith(quote.id);

    expect(deletedQuote.id).toBe(quote.id);
  });
});
