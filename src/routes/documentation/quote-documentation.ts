import { z } from "zod";

import { createQuoteSchema } from "@/schemas/create-quote-schema";
import { listQuotesQuerySchema } from "@/schemas/list-quotes-query-schema";

import { updateQuoteStatusSchema } from "@/schemas/update-quote-status-schema";

const quoteSchemas = {
  createQuote: createQuoteSchema,
  listQuotes: listQuotesQuerySchema,
  updateQuoteStatus: updateQuoteStatusSchema,
  quoteIdParam: z.object({
    quoteId: z.string().uuid("Quote ID must be a valid UUID"),
  }),
};

const quoteResponses = {
  quoteCreated: z.object({
    message: z
      .string()
      .default(
        "Orçamento solicitado com sucesso! Em breve entraremos em contato.",
      ),
  }),
  quoteStatusUpdated: z.object({
    message: z.string().default("Status do orçamento atualizado com sucesso!"),
  }),
  quoteDeleted: z.object({
    message: z.string().default("Orçamento deletado com sucesso!"),
  }),
  quotesList: z.object({
    data: z.array(
      z.object({
        id: z.string().describe("Quote ID"),
        name: z.string().describe("Customer full name"),
        company: z.string().describe("Company name"),
        email: z.string().describe("Customer email address"),
        telephone: z.string().describe("Customer phone number"),
        fleet_size: z
          .enum(["1-5", "6-15", "16-30", "31-50", "51-100", "101+"])
          .describe("Fleet size category"),
        message: z
          .string()
          .nullable()
          .describe("Additional message from customer"),
        status: z
          .enum(["PENDING", "CONTACTED", "CLOSED", "CONVERTED"])
          .describe("Quote status"),
        notes: z.string().nullable().describe("Internal notes about the quote"),
        created_at: z.string().describe("Quote creation timestamp"),
        updated_at: z.string().describe("Quote last update timestamp"),
      }),
    ),
    total: z.number().describe("Total number of quotes"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  quoteNotFound: z.object({
    message: z.string().default("Orçamento não encontrado!"),
  }),
  validationError: z.object({
    message: z.string().default("Erro de validação"),
    issues: z.array(z.string()).describe("List of validation errors"),
  }),
  rateLimitExceeded: z.object({
    message: z
      .string()
      .default("Muitas solicitações. Tente novamente mais tarde."),
    statusCode: z.number().default(429),
    error: z.string().default("Too Many Requests"),
  }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { quoteSchemas, quoteResponses };
