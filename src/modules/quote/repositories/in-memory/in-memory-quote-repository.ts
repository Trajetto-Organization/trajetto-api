import { Prisma } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import {
  compareForOrder,
  type NullsPlacement,
  type OrderValue,
} from "@/shared/pagination/in-memory-order";

import {
  QUOTE_SORT_FALLBACK,
  type QuoteGroupCount,
  type QuoteListFilters,
  type QuoteSortKey,
} from "../../usecases/list-quotes/quote-list";

import {
  CreateQuoteProps,
  Quote,
  ListQuotesProps,
  ListQuotesResult,
  UpdateQuoteProps,
} from "../../dtos/quote-dto";
import { IQuoteRepository } from "../IQuote-repository";

/** Postgres ILIKE '%term%' after literalContains: a plain case-insensitive substring. */
const containsInsensitive = (value: string | null | undefined, term: string) =>
  (value ?? "").toLowerCase().includes(term.toLowerCase());

/** The pipeline order the QuoteStatus enum declares (Postgres sorts by it). */
const STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  CONTACTED: 1,
  CLOSED: 2,
  CONVERTED: 3,
};

/** The keys QUOTE_SORT orders with `nulls: "last"`. */
const QUOTE_NULLS: Partial<Record<QuoteSortKey, NullsPlacement>> = {
  contacted_at: "last",
};

/** What Prisma raises for an update or delete of a missing row. */
const recordNotFound = (message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code: "P2025",
    clientVersion: "in-memory",
  });

/**
 * The quote table in memory, answering as QuoteRepository does (decision
 * 13.2): the list's search, facets, order (NULLs and the created_at/id
 * tiebreaker included) and breakdown, and an update that writes what the use
 * case computed — the use case owns contacted_at, not the repository.
 */
class InMemoryQuoteRepository implements IQuoteRepository {
  public quotes: Quote[] = [];

  async createQuote(quoteData: CreateQuoteProps): Promise<Quote> {
    const quote: Quote = {
      id: uuidV7(),
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

  async findQuoteByEmail(email: string, since?: Date): Promise<Quote | null> {
    const matches = this.quotes
      .filter((q) => q.email.toLowerCase() === email.toLowerCase())
      .filter((q) => !since || new Date(q.created_at) >= since)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );

    return matches[0] || null;
  }

  /** quoteListWhere, row by row. */
  private matches(
    quote: Quote,
    filters: QuoteListFilters,
    { withFacets }: { withFacets: boolean },
  ): boolean {
    if (withFacets) {
      if (filters.statuses?.length && !(filters.statuses as string[]).includes(quote.status)) {
        return false;
      }

      if (
        filters.fleetSizes?.length &&
        !(filters.fleetSizes as string[]).includes(quote.fleet_size)
      ) {
        return false;
      }
    }

    const term = filters.search?.trim() ?? "";

    if (!term) return true;

    const digits = term.replace(/\D/g, "");
    const phoneDigits = digits.startsWith("55") && digits.length > 10 ? digits.slice(2) : digits;

    return (
      [
        quote.id,
        quote.name,
        quote.company,
        quote.email,
        quote.fleet_size,
        quote.message,
        quote.notes,
      ].some((value) => containsInsensitive(value, term)) ||
      (digits !== "" && quote.telephone.includes(phoneDigits))
    );
  }

  /** QUOTE_SORT, compared the way Postgres sorts it. */
  private compare(sort: QuoteSortKey, order: "asc" | "desc") {
    const valueOf = (quote: Quote): OrderValue => {
      if (sort === "status") return STATUS_RANK[quote.status];
      if (sort === "created_at" || sort === "updated_at" || sort === "contacted_at") {
        const value = quote[sort];

        return value == null ? null : new Date(value);
      }

      return quote[sort];
    };

    return (a: Quote, b: Quote): number =>
      compareForOrder(valueOf(a), valueOf(b), order, QUOTE_NULLS[sort]) ||
      compareForOrder(new Date(a.created_at), new Date(b.created_at), "desc") ||
      compareForOrder(a.id, b.id, "desc");
  }

  async listQuotes({
    page,
    pageSize,
    search,
    statuses,
    fleetSizes,
    sort,
    order,
  }: ListQuotesProps): Promise<ListQuotesResult> {
    const filters: QuoteListFilters = { search, statuses, fleetSizes };

    const resolvedSort = sort ?? QUOTE_SORT_FALLBACK.sort;
    const resolvedOrder = order ?? (sort ? "asc" : QUOTE_SORT_FALLBACK.order);

    const filtered = this.quotes
      .filter((quote) => this.matches(quote, filters, { withFacets: true }))
      .sort(this.compare(resolvedSort, resolvedOrder));

    const groups = new Map<string, QuoteGroupCount>();

    for (const quote of this.quotes) {
      if (!this.matches(quote, filters, { withFacets: false })) continue;

      const key = `${quote.status}|${quote.fleet_size}`;
      const group = groups.get(key) ?? {
        status: quote.status,
        fleet_size: quote.fleet_size,
        count: 0,
      };

      group.count += 1;
      groups.set(key, group);
    }

    const start = (page - 1) * pageSize;

    return {
      data: filtered.slice(start, start + pageSize),
      groups: Array.from(groups.values()),
    };
  }

  async updateQuoteStatus({
    quoteId,
    quoteData,
  }: UpdateQuoteProps): Promise<Quote> {
    const quoteIndex = this.quotes.findIndex((q) => q.id === quoteId);

    if (quoteIndex === -1) {
      throw recordNotFound("Record to update not found.");
    }

    // Exactly what the use case sent, as Prisma writes it: undefined is "not
    // sent". The twin used to re-derive contacted_at on its own rules (and
    // cleared it on CONVERTED), which the real repository never did.
    const sent = Object.fromEntries(
      Object.entries(quoteData).filter(([, value]) => value !== undefined),
    );

    const updatedQuote = {
      ...this.quotes[quoteIndex],
      ...sent,
      updated_at: new Date(),
    } as Quote;

    this.quotes[quoteIndex] = updatedQuote;
    return updatedQuote;
  }

  async deleteQuote(quoteId: string): Promise<Quote> {
    const quoteIndex = this.quotes.findIndex((q) => q.id === quoteId);

    if (quoteIndex === -1) {
      throw recordNotFound("Record to delete does not exist.");
    }

    const deletedQuote = this.quotes[quoteIndex];

    this.quotes.splice(quoteIndex, 1);
    return deletedQuote;
  }
}

export { InMemoryQuoteRepository };
