import {
  CreateQuoteProps,
  Quote,
  ListQuotesProps,
  ListQuotesResult,
  UpdateQuoteProps,
} from "../dtos/quote-dto";

interface IQuoteRepository {
  createQuote: (quoteData: CreateQuoteProps) => Promise<Quote>;
  findQuoteById: (quoteId: string) => Promise<Quote | null>;
  /**
   * The newest quote from this address, ignoring case; with `since`, only one
   * created at or after it (which keeps the lookup on the created_at index).
   */
  findQuoteByEmail: (email: string, since?: Date) => Promise<Quote | null>;
  listQuotes: (params: ListQuotesProps) => Promise<ListQuotesResult>;
  updateQuoteStatus: ({
    quoteData,
    quoteId,
  }: UpdateQuoteProps) => Promise<Quote>;
  deleteQuote: (quoteId: string) => Promise<Quote>;
}

export { IQuoteRepository };
