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
  findQuoteByEmail: (email: string) => Promise<Quote | null>;
  listQuotes: (params: ListQuotesProps) => Promise<ListQuotesResult>;
  updateQuoteStatus: ({
    quoteData,
    quoteId,
  }: UpdateQuoteProps) => Promise<Quote>;
  deleteQuote: (quoteId: string) => Promise<Quote>;
}

export { IQuoteRepository };
