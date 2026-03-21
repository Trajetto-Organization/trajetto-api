type QuoteStatus = "PENDING" | "CONTACTED" | "CLOSED" | "CONVERTED";

interface Quote {
  id: string;
  name: string;
  company: string;
  email: string;
  telephone: string;
  fleet_size: string;
  message?: string | null;
  status: QuoteStatus;
  contacted_at?: Date | string | null;
  notes?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ListQuotesProps {
  page: number;
  pageSize: number;
  search?: string;
  status?: QuoteStatus;
}

interface ListQuotesResult {
  data: Quote[];
  total: number;
}

interface CreateQuoteProps {
  name: string;
  company: string;
  email: string;
  telephone: string;
  fleet_size: string;
  message?: string | null;
}

interface UpdateQuoteProps {
  quoteId: string;
  quoteData: {
    status: QuoteStatus;
    notes?: string;
  };
}

export {
  CreateQuoteProps,
  Quote,
  QuoteStatus,
  ListQuotesProps,
  ListQuotesResult,
  UpdateQuoteProps,
};
