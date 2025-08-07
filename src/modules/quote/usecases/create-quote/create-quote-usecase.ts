import { inject, injectable } from "tsyringe";

import { IQuoteRepository } from "../../repositories/IQuote-repository";
import { CreateQuoteProps, Quote } from "../../dtos/quote-dto";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { AppError } from "@/shared/errors/AppError";

import { env } from "@/env";

@injectable()
class CreateQuoteUseCase {
  private http_request = env.HTTP_REQUEST;
  private emailQueue: EmailWorkerAdapter;

  constructor(
    @inject("QuoteRepository")
    private quoteRepository: IQuoteRepository,
  ) {
    this.emailQueue = new EmailWorkerAdapter("quoteEmailQueue");
  }

  async execute(quoteData: CreateQuoteProps): Promise<Quote> {
    try {
      // Create a quote request in the bank
      const quote = await this.quoteRepository.createQuote(quoteData);

      // Send emails asynchronously
      this.sendEmails(quote).catch((error) => {
        console.error("Erro ao enviar emails para quote:", quote.id, error);
      });

      return quote;
    } catch (error) {
      throw new AppError(
        "Erro ao processar sua solicitação de orçamento. Tente novamente.",
        500,
      );
    }
  }

  private async sendEmails(quote: Quote): Promise<void> {
    try {
      // Email to sales team
      await this.emailQueue.enqueueEmail({
        email: "vendas@trajetto.com",
        name: "Equipe de Vendas",
        subject: `Nova Solicitação de Orçamento - ${quote.company}`,
        templateName: "new-quote-notification.hbs",
        moduleName: "quote",
        additionalVariablesProperties: {
          clientName: quote.name,
          company: quote.company,
          email: quote.email,
          telephone: quote.telephone,
          fleetSize: this.translateFleetSize(quote.fleet_size),
          message: quote.message || "Nenhuma mensagem adicional",
          quoteId: quote.id,
          dashboardUrl: `${this.http_request}/admin/quote?search=${quote.id}&page=1`,
        },
      });

      // Confirmation email to customer
      await this.emailQueue.enqueueEmail({
        email: quote.email,
        name: quote.name,
        subject: "Recebemos sua solicitação de orçamento - Trajetto",
        templateName: "quote-confirmation.hbs",
        moduleName: "quote",
        additionalVariablesProperties: {
          company: quote.company,
          fleetSize: this.translateFleetSize(quote.fleet_size),
          supportEmail: "suporte@trajetto.com",
          salesPhone: "(11) 99999-9999",
        },
      });

      console.log(`Emails enviados com sucesso para quote: ${quote.id}`);
    } catch (error) {
      console.error(`Erro ao enviar emails para quote ${quote.id}:`, error);
    }
  }

  private translateFleetSize(fleetSize: string): string {
    const translations: Record<string, string> = {
      "1-5": "1 a 5 veículos",
      "6-15": "6 a 15 veículos",
      "16-30": "16 a 30 veículos",
      "31-50": "31 a 50 veículos",
      "51-100": "51 a 100 veículos",
      "101+": "Mais de 100 veículos",
    };

    return translations[fleetSize] || fleetSize;
  }
}

export { CreateQuoteUseCase };
