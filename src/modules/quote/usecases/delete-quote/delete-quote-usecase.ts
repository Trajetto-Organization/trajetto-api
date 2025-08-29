import { inject, injectable } from "tsyringe";

import { IQuoteRepository } from "../../repositories/IQuote-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { Quote } from "../../dtos/quote-dto";

import { QuoteAccessDeniedError } from "../errors/quote-access denied-error";
import { QuoteNotFoundError } from "../errors/quote-not-found-error";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class DeleteQuoteUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("QuoteRepository")
    private quoteRepository: IQuoteRepository,
  ) {}

  async execute(quoteId: string, userId: string): Promise<Quote> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    if (user.role !== "MASTER") {
      throw new QuoteAccessDeniedError();
    }

    const quote = await this.quoteRepository.findQuoteById(quoteId);

    if (!quote) {
      throw new QuoteNotFoundError();
    }

    try {
      const deletedQuote = await this.quoteRepository.deleteQuote(quoteId);
      return deletedQuote;
    } catch (error) {
      throw new AppError("Erro ao deletar orçamento", 500);
    }
  }
}

export { DeleteQuoteUseCase };
