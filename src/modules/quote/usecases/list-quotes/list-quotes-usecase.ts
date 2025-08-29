import { inject, injectable } from "tsyringe";

import { IQuoteRepository } from "../../repositories/IQuote-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ListQuotesResult, QuoteStatus } from "../../dtos/quote-dto";

import { AppError } from "@/shared/errors/AppError";
import { QuoteAccessDeniedError } from "../errors/quote-access denied-error";

interface ListQuotesRequest {
  userId: string;
  page: number;
  pageSize: number;
  search?: string;
  status?: QuoteStatus;
}

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
    status,
  }: ListQuotesRequest): Promise<ListQuotesResult> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    if (user.role !== "MASTER") {
      throw new QuoteAccessDeniedError();
    }

    try {
      const quotes = await this.quoteRepository.listQuotes({
        page,
        pageSize,
        search,
        status,
      });

      return quotes;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar as solicitações de orçamento",
        500,
      );
    }
  }
}

export { ListQuotesUseCase };
