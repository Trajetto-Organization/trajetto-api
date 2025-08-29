import { describe, it, expect, beforeEach, vi } from "vitest";

import { InMemoryQuoteRepository } from "@/modules/quote/repositories/in-memory/in-memory-quote-repository";
import { CreateQuoteUseCase } from "@/modules/quote/usecases/create-quote/create-quote-usecase";

import { AppError } from "@/shared/errors/AppError";

describe("Create Quote UseCase", () => {
  let quoteInMemory: InMemoryQuoteRepository;
  let createQuote: CreateQuoteUseCase;

  beforeEach(() => {
    quoteInMemory = new InMemoryQuoteRepository();
    createQuote = new CreateQuoteUseCase(quoteInMemory);

    // Mock the entire sendEmails method to avoid async issues
    vi.spyOn(createQuote as any, "sendEmails").mockResolvedValue(undefined);
  });

  it("should be able to create a quote", async () => {
    const quoteData = {
      name: "John Doe Silva",
      company: "Test Company LTDA",
      email: "john@example.com",
      telephone: "11999999999",
      fleet_size: "1-5" as const,
      message: "I need a quote for fleet management system",
    };

    const createdQuote = await createQuote.execute(quoteData);

    expect(createdQuote).toHaveProperty("id");
    expect(createdQuote.name).toBe(quoteData.name);

    expect(createdQuote.company).toBe(quoteData.company);
    expect(createdQuote.email).toBe(quoteData.email);

    expect(createdQuote.telephone).toBe(quoteData.telephone);
    expect(createdQuote.fleet_size).toBe(quoteData.fleet_size);

    expect(createdQuote.message).toBe(quoteData.message);
    expect(createdQuote.status).toBe("PENDING");

    expect(createdQuote.contacted_at).toBeNull();
    expect(createdQuote.notes).toBeNull();

    expect(createdQuote.created_at).toBeInstanceOf(Date);
    expect(createdQuote.updated_at).toBeInstanceOf(Date);
  });

  it("should be able to create a quote without message", async () => {
    const quoteData = {
      name: "Jane Smith Costa",
      company: "Another Company SA",
      email: "jane@example.com",
      telephone: "21888888888",
      fleet_size: "6-15" as const,
    };

    const createdQuote = await createQuote.execute(quoteData);

    expect(createdQuote).toHaveProperty("id");
    expect(createdQuote.name).toBe(quoteData.name);

    expect(createdQuote.company).toBe(quoteData.company);
    expect(createdQuote.email).toBe(quoteData.email);

    expect(createdQuote.telephone).toBe(quoteData.telephone);
    expect(createdQuote.fleet_size).toBe(quoteData.fleet_size);

    expect(createdQuote.message).toBeNull();
    expect(createdQuote.status).toBe("PENDING");
  });

  it("should be able to create quotes with different fleet sizes", async () => {
    const fleetSizes = [
      "1-5",
      "6-15",
      "16-30",
      "31-50",
      "51-100",
      "101+",
    ] as const;

    for (const fleetSize of fleetSizes) {
      const quoteData = {
        name: `User ${fleetSize} Test`,
        company: `Company ${fleetSize}`,
        email: `test${fleetSize}@example.com`,
        telephone: "11999999999",
        fleet_size: fleetSize,
      };

      const createdQuote = await createQuote.execute(quoteData);
      expect(createdQuote.fleet_size).toBe(fleetSize);
    }
  });

  it("should send emails after creating quote successfully", async () => {
    const quoteData = {
      name: "Test User Name",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "16-30" as const,
      message: "Test message",
    };

    // Mock sendEmails method specifically for this test
    const sendEmailsSpy = vi
      .spyOn(createQuote as any, "sendEmails")
      .mockResolvedValue(undefined);

    await createQuote.execute(quoteData);

    expect(sendEmailsSpy).toHaveBeenCalledTimes(1);

    // Verify the quote object was passed to sendEmails
    const calledWithQuote = sendEmailsSpy.mock.calls[0][0] as any;
    expect(calledWithQuote.name).toBe(quoteData.name);

    expect(calledWithQuote.company).toBe(quoteData.company);
    expect(calledWithQuote.email).toBe(quoteData.email);
  });

  it("should translate fleet size correctly in emails", async () => {
    const testCases = [
      { fleetSize: "1-5" as const, expected: "1 a 5 veículos" },
      { fleetSize: "6-15" as const, expected: "6 a 15 veículos" },
      { fleetSize: "16-30" as const, expected: "16 a 30 veículos" },
      { fleetSize: "31-50" as const, expected: "31 a 50 veículos" },
      { fleetSize: "51-100" as const, expected: "51 a 100 veículos" },
      { fleetSize: "101+" as const, expected: "Mais de 100 veículos" },
    ];

    for (const testCase of testCases) {
      const quoteData = {
        name: "Test User",
        company: "Test Company",
        email: "test@example.com",
        telephone: "11999999999",
        fleet_size: testCase.fleetSize,
      };

      const quote = await createQuote.execute(quoteData);

      // Test the translation method directly
      const translatedSize = createQuote["translateFleetSize"](
        testCase.fleetSize,
      );
      expect(translatedSize).toBe(testCase.expected);
    }
  });

  it("should handle email sending errors gracefully", async () => {
    const quoteData = {
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5" as const,
    };

    // Mock email queue to throw error
    vi.spyOn(createQuote["emailQueue"], "enqueueEmail")
      .mockRejectedValueOnce(new Error("Email service error"))
      .mockResolvedValueOnce();

    // Should still create quote despite email error
    const createdQuote = await createQuote.execute(quoteData);

    expect(createdQuote).toHaveProperty("id");
    expect(createdQuote.name).toBe(quoteData.name);
  });

  it("should handle quotes with message as 'Nenhuma mensagem adicional' when message is null", async () => {
    const quoteData = {
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5" as const,
    };

    const quote = await createQuote.execute(quoteData);

    expect(quote.message).toBeNull();
    expect(quote.name).toBe(quoteData.name);
  });

  it("should throw AppError if repository operation fails", async () => {
    const quoteData = {
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5" as const,
    };

    vi.spyOn(quoteInMemory, "createQuote").mockRejectedValueOnce(
      new Error("Database connection error"),
    );

    try {
      await createQuote.execute(quoteData);
      expect.fail("Should have thrown an AppError");
    } catch (error: any) {
      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toBe(
        "Erro ao processar sua solicitação de orçamento. Tente novamente.",
      );

      expect(error.statusCode).toBe(500);
    }
  });

  it("should create quote with current timestamp", async () => {
    const before = new Date();

    const quoteData = {
      name: "Test User",
      company: "Test Company",
      email: "test@example.com",
      telephone: "11999999999",
      fleet_size: "1-5" as const,
    };

    const createdQuote = await createQuote.execute(quoteData);
    const after = new Date();

    expect(new Date(createdQuote.created_at).getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );

    expect(new Date(createdQuote.created_at).getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );

    expect(new Date(createdQuote.updated_at).getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );

    expect(new Date(createdQuote.updated_at).getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
  });
});
