import { IQuoteRepository } from "./IQuote-repository";
import {
  CreateQuoteProps,
  Quote,
  ListQuotesProps,
  ListQuotesResult,
  UpdateQuoteProps,
} from "../dtos/quote-dto";

import database from "@/../infra/database";

import { QUOTE_SORT, quoteListWhere } from "../usecases/list-quotes/quote-list";

import { resolveOrderBy } from "@/shared/pagination/list-query";
import { insensitiveEquals } from "@/shared/utils/like-pattern";

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

  async findQuoteByEmail(email: string, since?: Date): Promise<Quote | null> {
    const quote = await this.prisma.quote.findFirst({
      where: {
        // One mailbox, however the requester capitalised it.
        // Escaped too: the value is an ILIKE pattern underneath, and "%@x"
        // would collapse every request of a domain into one (like-pattern.ts).
        email: insensitiveEquals(email),
        ...(since ? { created_at: { gte: since } } : {}),
      },
      orderBy: {
        created_at: "desc",
      },
    });

    return quote;
  }

  /**
   * One page ‖ the (status, fleet_size) breakdown: at most two connections
   * (connection-fan-out budget). The cards and facet options are derived
   * from the breakdown, never from the page (decision 8.8).
   */
  async listQuotes({
    page,
    pageSize,
    search,
    statuses,
    fleetSizes,
    sort,
    order,
  }: ListQuotesProps): Promise<ListQuotesResult> {
    const filters = { search, statuses, fleetSizes };

    const [data, grouped] = await Promise.all([
      this.prisma.quote.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: quoteListWhere(filters),
        orderBy: resolveOrderBy(QUOTE_SORT, { sort, order }),
      }),
      this.prisma.quote.groupBy({
        by: ["status", "fleet_size"],
        where: quoteListWhere(filters, { except: "facets" }),
        _count: { _all: true },
      }),
    ]);

    return {
      data,
      groups: grouped.map((group) => ({
        status: group.status,
        fleet_size: group.fleet_size,
        count: group._count._all,
      })),
    };
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
