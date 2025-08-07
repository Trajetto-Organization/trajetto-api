import { inject, injectable } from "tsyringe";

import { IQuoteRepository } from "../../repositories/IQuote-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { Quote, QuoteStatus } from "../../dtos/quote-dto";

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
      throw new AppError("Acesso negado", 403);
    }

    const quote = await this.quoteRepository.findQuoteById(quoteId);

    if (!quote) {
      throw new AppError("Orçamento não encontrado", 404);
    }

    const updateData: any = {
      status,
      notes,
      updated_at: new Date(),
    };

    if (status === "CONTACTED" || status === "CLOSED") {
      updateData.contacted_at = new Date();
    }

    try {
      const updatedQuote = await this.quoteRepository.updateQuoteStatus({
        quoteId,
        quoteData: updateData,
      });

      return updatedQuote;
    } catch (error) {
      throw new AppError("Erro ao atualizar status do orçamento", 500);
    }
  }
}

export { UpdateQuoteStatusUseCase };
