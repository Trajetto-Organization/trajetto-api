import { inject, injectable } from "tsyringe";

import { IQuoteRepository } from "../../repositories/IQuote-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { Quote, QuoteStatus } from "../../dtos/quote-dto";

import { QuoteNotFoundError } from "../errors/quote-not-found-error";
import { QuoteAccessDeniedError } from "../errors/quote-access denied-error";

import { QuoteAlreadyFinalizedError } from "../errors/quote-already-finalized-error";
import { AppError } from "@/shared/errors/AppError";

interface UpdateQuoteStatusRequest {
  quoteId: string;
  status: QuoteStatus;
  notes?: string;
  userId: string;
}

@injectable()
class UpdateQuoteStatusUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("QuoteRepository")
    private quoteRepository: IQuoteRepository,
  ) {}

  async execute({
    quoteId,
    status,
    notes,
    userId,
  }: UpdateQuoteStatusRequest): Promise<Quote> {
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

    // Validate if quote is already finalized (CLOSED or CONVERTED)
    if (quote.status === "CLOSED" || quote.status === "CONVERTED") {
      throw new QuoteAlreadyFinalizedError();
    }

    const updateData: any = {
      status,
      notes,
      updated_at: new Date(),
    };

    // Only update contacted_at when status changes to CONTACTED or CLOSED
    if (
      (status === "CONTACTED" || status === "CLOSED") &&
      quote.status !== status
    ) {
      updateData.contacted_at = new Date();
    }

    try {
      const updatedQuote = await this.quoteRepository.updateQuoteStatus({
        quoteId,
        quoteData: updateData,
      });

      return updatedQuote;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o status do orçamento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateQuoteStatusUseCase };
