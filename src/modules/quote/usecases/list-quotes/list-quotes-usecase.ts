import { inject, injectable } from "tsyringe";

import { IQuoteRepository } from "../../repositories/IQuote-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { Quote, QuoteStatus } from "../../dtos/quote-dto";

import { AppError } from "@/shared/errors/AppError";
import type { SortOrder } from "@/shared/pagination/list-query";

import { QuoteAccessDeniedError } from "../errors/quote-access denied-error";

import {
  summarizeQuoteList,
  type QuoteFleetSize,
  type QuoteListSearchMeta,
  type QuoteSortKey,
} from "./quote-list";

interface ListQuotesRequest {
  userId: string;
  page: number;
  pageSize: number;
  search?: string;
  statuses?: QuoteStatus[];
  fleetSizes?: QuoteFleetSize[];
  sort?: QuoteSortKey;
  order?: SortOrder;
}

interface ListQuotesResponse {
  data: Quote[];
  /** Rows of search + every facet: what the pager counts. */
  total: number;
  /** The NDJSON meta line's `searchMeta`: cards and facet options. */
  searchMeta: QuoteListSearchMeta;
}

/**
 * The quotes table of /admin (decision 8.8): the order, the stage and fleet
 * size filters and the per-stage cards answered over every quote.
 */
@injectable()
class ListQuotesUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("QuoteRepository")
    private quoteRepository: IQuoteRepository,
  ) {}

  async execute({
    userId,
    page,
    pageSize,
    search,
    statuses,
    fleetSizes,
    sort,
    order,
  }: ListQuotesRequest): Promise<ListQuotesResponse> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    if (user.role !== "MASTER") {
      throw new QuoteAccessDeniedError();
    }

    try {
      const result = await this.quoteRepository.listQuotes({
        page,
        pageSize,
        search,
        statuses,
        fleetSizes,
        sort,
        order,
      });

      const { total, searchMeta } = summarizeQuoteList(result.groups, {
        statuses,
        fleetSizes,
      });

      return { data: result.data, total, searchMeta };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as solicitações de orçamento",
        500,
      );
    }
  }
}

export { ListQuotesUseCase };
export type { ListQuotesRequest, ListQuotesResponse };
