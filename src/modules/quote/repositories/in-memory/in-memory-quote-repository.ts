import {
  CreateQuoteProps,
  Quote,
  ListQuotesProps,
  ListQuotesResult,
  UpdateQuoteProps,
} from "../../dtos/quote-dto";
import { IQuoteRepository } from "../IQuote-repository";

class InMemoryQuoteRepository implements IQuoteRepository {
  public quotes: Quote[] = [];

  async createQuote(quoteData: CreateQuoteProps): Promise<Quote> {
    const quote: Quote = {
      id: `quote-${Date.now()}-${Math.random().toString(36).substring(2)}`,
      name: quoteData.name,
      company: quoteData.company,
      email: quoteData.email,
      telephone: quoteData.telephone,
      fleet_size: quoteData.fleet_size,
      message: quoteData.message || null,
      status: "PENDING",
      contacted_at: null,
      notes: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.quotes.push(quote);
    return quote;
  }

  async findQuoteById(quoteId: string): Promise<Quote | null> {
    const quote = this.quotes.find((q) => q.id === quoteId);
    return quote || null;
  }

  async findQuoteByEmail(email: string): Promise<Quote | null> {
    const quote = this.quotes.find((q) => q.email === email);
    return quote || null;
  }

  async listQuotes(params: ListQuotesProps): Promise<ListQuotesResult> {
    let filteredQuotes = [...this.quotes];

    // Filter by status
    if (params.status) {
      filteredQuotes = filteredQuotes.filter((q) => q.status === params.status);
    }

    // Filter by search (name, company, email)
    if (params.search) {
      const searchLower = params.search.toLowerCase();
      filteredQuotes = filteredQuotes.filter(
        (q) =>
          q.name.toLowerCase().includes(searchLower) ||
          q.company.toLowerCase().includes(searchLower) ||
          q.email.toLowerCase().includes(searchLower),
      );
    }

    // Sort by created_at desc
    filteredQuotes.sort((a, b) => {
      const dateA = new Date(a.created_at).getTime();
      const dateB = new Date(b.created_at).getTime();

      return dateB - dateA;
    });

    // Pagination
    const startIndex = (params.page - 1) * params.pageSize;
    const endIndex = startIndex + params.pageSize;

    const paginatedQuotes = filteredQuotes.slice(startIndex, endIndex);

    return {
      data: paginatedQuotes,
      total: filteredQuotes.length,
    };
  }

  async updateQuoteStatus({
    quoteId,
    quoteData,
  }: UpdateQuoteProps): Promise<Quote> {
    const quoteIndex = this.quotes.findIndex((q) => q.id === quoteId);

    if (quoteIndex === -1) {
      throw new Error("Quote not found");
    }

    // Handle contacted_at logic based on status
    let updatedData: any = { ...quoteData };

    if (quoteData.status === "CONTACTED" || quoteData.status === "CLOSED") {
      updatedData.contacted_at = updatedData.contacted_at || new Date();
    } else if (
      quoteData.status === "PENDING" ||
      quoteData.status === "CONVERTED"
    ) {
      updatedData.contacted_at = null;
    }

    const updatedQuote = {
      ...this.quotes[quoteIndex],
      ...updatedData,
      updated_at: new Date(),
    };

    this.quotes[quoteIndex] = updatedQuote;
    return updatedQuote;
  }

  async deleteQuote(quoteId: string): Promise<Quote> {
    const quoteIndex = this.quotes.findIndex((q) => q.id === quoteId);

    if (quoteIndex === -1) {
      throw new Error("Quote not found");
    }

    const deletedQuote = this.quotes[quoteIndex];

    this.quotes.splice(quoteIndex, 1);
    return deletedQuote;
  }
}

export { InMemoryQuoteRepository };
