import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  QuoteFleetSize,
  QuoteGroupCount,
  QuoteSortKey,
} from "../usecases/list-quotes/quote-list";

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
  statuses?: QuoteStatus[];
  fleetSizes?: QuoteFleetSize[];
  sort?: QuoteSortKey;
  order?: SortOrder;
}

/**
 * One page of quotes and the breakdown the cards and filters are derived
 * from (decision 8.8): never counted on the page.
 */
interface ListQuotesResult {
  data: Quote[];
  /** Quotes per (status, fleet_size): search applied, the two facets not. */
  groups: QuoteGroupCount[];
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
