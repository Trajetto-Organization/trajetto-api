import { inject, injectable } from "tsyringe";

import { IQuoteRepository } from "../../repositories/IQuote-repository";
import { CreateQuoteProps, Quote } from "../../dtos/quote-dto";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";

import { env } from "@/env";

const log = logger.child({ component: "quote" });

/** At most one confirmation per requester address in this window. */
const CONFIRMATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

@injectable()
class CreateQuoteUseCase {
  private http_request = env.HTTP_REQUEST;

  constructor(
    @inject("QuoteRepository")
    private quoteRepository: IQuoteRepository,
  ) {}

  async execute(quoteData: CreateQuoteProps): Promise<Quote> {
    try {
      // Read BEFORE the new row exists, or it would always find itself. The
      // form is public and mails the address typed into it: one confirmation
      // a day per address caps what a flood can send to any one mailbox.
      const previous = await this.quoteRepository.findQuoteByEmail(
        quoteData.email.trim(),
        new Date(Date.now() - CONFIRMATION_INTERVAL_MS),
      );

      // Create a quote request in the bank
      const quote = await this.quoteRepository.createQuote(quoteData);

      // Send emails asynchronously
      this.sendEmails(quote, { confirmRequester: !previous }).catch((error) => {
        log.error(
          { err: error, quoteId: quote.id },
          "quote e-mails could not be sent",
        );
      });

      return quote;
    } catch (error) {
      throw new AppError(
        "Erro ao processar sua solicitação de orçamento. Tente novamente.",
        500,
      );
    }
  }

  private async sendEmails(
    quote: Quote,
    { confirmRequester }: { confirmRequester: boolean },
  ): Promise<void> {
    try {
      // Email to sales team
      await sendTransactionalMail({
        email: "contato@intrajetto.com",
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

      // Confirmation email to customer.
      //
      // Nothing the requester typed goes into it — no name, no company. The
      // route is public and this mail goes to whatever address was posted,
      // from the product's own sender: echoing free text made it a way to
      // send "Olá, golpe.example/resgate! … Seu CPF foi bloqueado" as
      // Trajetto to anyone. Escaping stops markup, not words. The fleet size
      // is safe: it is an enum, translated here.
      if (confirmRequester) {
        await sendTransactionalMail({
          email: quote.email,
          subject: "Recebemos sua solicitação de orçamento - Trajetto",
          templateName: "quote-confirmation.hbs",
          moduleName: "quote",
          additionalVariablesProperties: {
            fleetSize: this.translateFleetSize(quote.fleet_size),
            supportEmail: "contato@intrajetto.com",
            salesPhone: "(11) 99999-9999",
          },
        });
      }

      log.info({ quoteId: quote.id }, "quote e-mails sent");
    } catch (error) {
      log.error(
        { err: error, quoteId: quote.id },
        "quote e-mails could not be sent",
      );
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
