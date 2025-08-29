import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryQuoteRepository } from "@/modules/quote/repositories/in-memory/in-memory-quote-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { ListQuotesUseCase } from "@/modules/quote/usecases/list-quotes/list-quotes-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { QuoteAccessDeniedError } from "@/modules/quote/usecases/errors/quote-access denied-error";
import { AppError } from "@/shared/errors/AppError";

type UserRole = "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";

describe("List Quotes UseCase", () => {
  let userInMemory: InMemoryUserRepository;
  let quoteInMemory: InMemoryQuoteRepository;

  let listQuotes: ListQuotesUseCase;

  beforeEach(() => {
    userInMemory = new InMemoryUserRepository();
    quoteInMemory = new InMemoryQuoteRepository();

    listQuotes = new ListQuotesUseCase(userInMemory, quoteInMemory);
  });

  it("should be able to list quotes for MASTER user", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create test quotes
    const quotes = [
      {
        name: "John Doe Silva",
        company: "Company A",
        email: "john@companya.com",
        telephone: "11999999999",
        fleet_size: "1-5" as const,
        message: "Need quote for small fleet",
      },
      {
        name: "Jane Smith Costa",
        company: "Company B",
        email: "jane@companyb.com",
        telephone: "21888888888",
        fleet_size: "16-30" as const,
        message: "Looking for fleet management solution",
      },
    ];

    for (const quoteData of quotes) {
      await quoteInMemory.createQuote(quoteData);
    }

    const result = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);

    // Check that we have the correct quotes, order might vary due to timing
    const names = result.data.map((quote) => quote.name);

    expect(names).toContain("John Doe Silva");
    expect(names).toContain("Jane Smith Costa");
  });

  it("should be able to filter quotes by status", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create quotes
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

    // Update one quote status
    await quoteInMemory.updateQuoteStatus({
      quoteId: quote1.id,
      quoteData: { status: "CONTACTED", notes: "Contacted by phone" },
    });

    // Filter by PENDING status
    const pendingResult = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 10,
      status: "PENDING",
    });

    expect(pendingResult.data).toHaveLength(1);
    expect(pendingResult.total).toBe(1);

    expect(pendingResult.data[0].id).toBe(quote2.id);

    // Filter by CONTACTED status
    const contactedResult = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 10,
      status: "CONTACTED",
    });

    expect(contactedResult.data).toHaveLength(1);
    expect(contactedResult.total).toBe(1);

    expect(contactedResult.data[0].id).toBe(quote1.id);
  });

  it("should be able to search quotes by name, company, or email", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const quotes = [
      {
        name: "John Doe Silva",
        company: "Tech Solutions",
        email: "john@techsolutions.com",
        telephone: "11999999999",
        fleet_size: "1-5" as const,
      },
      {
        name: "Jane Smith Costa",
        company: "Marketing Pro",
        email: "jane@marketingpro.com",
        telephone: "21888888888",
        fleet_size: "6-15" as const,
      },
      {
        name: "Bob Wilson Santos",
        company: "Transport Ltd",
        email: "bob@transport.com",
        telephone: "31777777777",
        fleet_size: "16-30" as const,
      },
    ];

    for (const quoteData of quotes) {
      await quoteInMemory.createQuote(quoteData);
    }

    // Search by name
    const nameResult = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 10,
      search: "john",
    });

    expect(nameResult.data).toHaveLength(1);
    expect(nameResult.data[0].name).toBe("John Doe Silva");

    // Search by company
    const companyResult = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 10,
      search: "marketing",
    });

    expect(companyResult.data).toHaveLength(1);
    expect(companyResult.data[0].company).toBe("Marketing Pro");

    // Search by email
    const emailResult = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 10,
      search: "transport.com",
    });

    expect(emailResult.data).toHaveLength(1);
    expect(emailResult.data[0].email).toBe("bob@transport.com");
  });

  it("should handle pagination correctly", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create 5 quotes
    for (let i = 1; i <= 5; i++) {
      await quoteInMemory.createQuote({
        name: `User ${i}`,
        company: `Company ${i}`,
        email: `user${i}@example.com`,
        telephone: "11999999999",
        fleet_size: "1-5",
      });
    }

    // Test first page (2 items per page)
    const firstPage = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 2,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.total).toBe(5);

    // Check that we have 2 users, order might vary due to timing
    const firstPageNames = firstPage.data.map((quote) => quote.name);

    expect(firstPageNames).toHaveLength(2);
    expect(firstPageNames.every((name) => name.startsWith("User"))).toBe(true);

    // Test second page
    const secondPage = await listQuotes.execute({
      userId: user.id,
      page: 2,
      pageSize: 2,
    });

    expect(secondPage.data).toHaveLength(2);
    expect(secondPage.total).toBe(5);

    // Check that second page has different users than first page
    const secondPageNames = secondPage.data.map((quote) => quote.name);

    expect(secondPageNames).toHaveLength(2);
    expect(secondPageNames.every((name) => name.startsWith("User"))).toBe(true);

    // Test third page (only 1 item)
    const thirdPage = await listQuotes.execute({
      userId: user.id,
      page: 3,
      pageSize: 2,
    });

    expect(thirdPage.data).toHaveLength(1);
    expect(thirdPage.total).toBe(5);

    const thirdPageName = thirdPage.data[0].name;
    expect(thirdPageName.startsWith("User")).toBe(true);
  });

  it("should return empty result when no quotes match criteria", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    await quoteInMemory.createQuote({
      name: "John Doe",
      company: "Test Company",
      email: "john@test.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    const result = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 10,
      search: "nonexistent",
    });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should return empty result when no quotes exist", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    const result = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("should filter quotes by status and search combined", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    // Create quotes
    const quote1 = await quoteInMemory.createQuote({
      name: "Tech User",
      company: "Tech Company",
      email: "tech@company.com",
      telephone: "11999999999",
      fleet_size: "1-5",
    });

    const quote2 = await quoteInMemory.createQuote({
      name: "Tech Support",
      company: "Support Ltd",
      email: "support@ltd.com",
      telephone: "21888888888",
      fleet_size: "6-15",
    });

    // Update one quote status
    await quoteInMemory.updateQuoteStatus({
      quoteId: quote1.id,
      quoteData: { status: "CONTACTED" },
    });

    // Filter by PENDING status and search for "tech"
    const result = await listQuotes.execute({
      userId: user.id,
      page: 1,
      pageSize: 10,
      status: "PENDING",
      search: "tech",
    });

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);

    expect(result.data[0].id).toBe(quote2.id);
  });

  it("should throw ResourceNotFoundError if user does not exist", async () => {
    await expect(
      listQuotes.execute({
        userId: "non-existing-user-id",
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("should throw QuoteAccessDeniedError if user is not MASTER", async () => {
    const nonMasterRoles: UserRole[] = ["BUSINESS_ADMIN", "BUSINESS_USER"];

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
        listQuotes.execute({
          userId: user.id,
          page: 1,
          pageSize: 10,
        }),
      ).rejects.toBeInstanceOf(QuoteAccessDeniedError);
    }
  });

  it("should throw AppError if list operation fails", async () => {
    const userData = {
      email: "master@example.com",
      password: "password",
      name: "Master User",
      businessId: "business-1",
      profileAccessId: "profile-1",
      role: "MASTER" as UserRole,
    };

    const user = await userInMemory.createUser(userData);

    vi.spyOn(quoteInMemory, "listQuotes").mockRejectedValueOnce(
      new Error("Database connection error"),
    );

    try {
      await listQuotes.execute({
        userId: user.id,
        page: 1,
        pageSize: 10,
      });
      expect.fail("Should have thrown an AppError");
    } catch (error: any) {
      expect(error).toBeInstanceOf(AppError);

      expect(error.message).toBe(
        "Houve um erro ao tentar listar as solicitações de orçamento",
      );
      expect(error.statusCode).toBe(500);
    }
  });

  it("should handle all quote statuses correctly", async () => {
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
    const quotes = [];

    // Create quotes for each status
    for (const status of statuses) {
      const quote = await quoteInMemory.createQuote({
        name: `User ${status}`,
        company: `Company ${status}`,
        email: `${status.toLowerCase()}@example.com`,
        telephone: "11999999999",
        fleet_size: "1-5",
      });

      if (status !== "PENDING") {
        await quoteInMemory.updateQuoteStatus({
          quoteId: quote.id,
          quoteData: { status },
        });
      }

      quotes.push({ quote, status });
    }

    // Test filtering by each status
    for (const { status } of quotes) {
      const result = await listQuotes.execute({
        userId: user.id,
        page: 1,
        pageSize: 10,
        status,
      });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);

      expect(result.data[0].status).toBe(status);
    }
  });
});
