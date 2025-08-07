import { IQuoteRepository } from "./IQuote-repository";
import {
  CreateQuoteProps,
  Quote,
  ListQuotesProps,
  ListQuotesResult,
  QuoteStatus,
  UpdateQuoteProps,
} from "../dtos/quote-dto";

import database from "@/../infra/database";
import { formatDate, formatTelephone } from "@/config/format-values";

class QuoteRepository implements IQuoteRepository {
  constructor(private prisma = database) {}

  async createQuote(quoteData: CreateQuoteProps): Promise<Quote> {
    const quote = await this.prisma.quote.create({
      data: {
        ...quoteData,
        message: quoteData.message || null,
      },
    });

    return quote;
  }

  async findQuoteById(quoteId: string): Promise<Quote | null> {
    const quote = await this.prisma.quote.findUnique({
      where: {
        id: quoteId,
      },
    });

    return quote;
  }

  async findQuoteByEmail(email: string): Promise<Quote | null> {
    const quote = await this.prisma.quote.findFirst({
      where: {
        email,
      },
      orderBy: {
        created_at: "desc",
      },
    });

    return quote;
  }

  async listQuotes({
    page,
    pageSize,
    search,
    status,
  }: ListQuotesProps): Promise<ListQuotesResult> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const digitSearch = normalizedSearch.replace(/\D/g, "");
    let digitSearchPhone = digitSearch;

    if (digitSearchPhone.startsWith("55") && digitSearchPhone.length > 10) {
      digitSearchPhone = digitSearchPhone.substring(2);
    }

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { name: { contains: normalizedSearch, mode: "insensitive" } },
        { company: { contains: normalizedSearch, mode: "insensitive" } },
        { email: { contains: normalizedSearch, mode: "insensitive" } },
        { fleet_size: { contains: normalizedSearch, mode: "insensitive" } },
        { message: { contains: normalizedSearch, mode: "insensitive" } },
        { notes: { contains: normalizedSearch, mode: "insensitive" } },
        ...(digitSearch
          ? [
              {
                telephone: { contains: digitSearchPhone, mode: "insensitive" },
              },
            ]
          : []),
      );
    }

    const whereCondition = {
      ...(status && { status }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const quotes = await this.prisma.quote.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      orderBy: {
        created_at: "desc",
      },
    });

    const total = await this.prisma.quote.count({
      where: whereCondition,
    });

    const transformedQuotes = quotes.map((quote) => ({
      id: quote.id,
      name: quote.name,
      company: quote.company,
      email: quote.email,
      telephone: formatTelephone(quote.telephone),
      fleet_size: quote.fleet_size,
      message: quote.message,
      status: quote.status as QuoteStatus,
      contacted_at: quote.contacted_at
        ? formatDate(quote.contacted_at, "pt-BR")
        : null,
      notes: quote.notes,
      created_at: formatDate(quote.created_at, "pt-BR"),
      updated_at: formatDate(quote.updated_at, "pt-BR"),
    }));

    return { data: transformedQuotes, total };
  }

  async updateQuoteStatus({
    quoteData,
    quoteId,
  }: UpdateQuoteProps): Promise<Quote> {
    const updatedQuote = await this.prisma.quote.update({
      where: {
        id: quoteId,
      },
      data: quoteData,
    });

    return updatedQuote;
  }

  async deleteQuote(quoteId: string): Promise<Quote> {
    const deletedQuote = await this.prisma.quote.delete({
      where: {
        id: quoteId,
      },
    });

    return deletedQuote;
  }
}

export { QuoteRepository };
