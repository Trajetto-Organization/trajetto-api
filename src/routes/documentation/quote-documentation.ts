import { z } from "zod";

import { searchMetaDoc } from "@/shared/pagination/list-meta";

import { createQuoteSchema } from "@/schemas/create-quote-schema";
import { listQuotesQuerySchema } from "@/schemas/list-quotes-query-schema";

import { updateQuoteStatusSchema } from "@/schemas/update-quote-status-schema";

import { errorResponse } from "./common-responses";

const quoteSchemas = {
  createQuote: createQuoteSchema,
  listQuotes: listQuotesQuerySchema,
  updateQuoteStatus: updateQuoteStatusSchema,
  quoteIdParam: z.object({
    quoteId: z.string().uuid("Quote ID must be a valid UUID"),
  }),
};

/** 403: quotes are the MASTER's alone. */
const masterOnly = errorResponse.describe(
  "PERMISSION_DENIED: só o MASTER acessa os pedidos de orçamento.",
);

/** 404 on a quote route: the quote, or the session user, is gone. */
const quoteNotFound = errorResponse.describe(
  "QUOTE_NOT_FOUND (o pedido não existe) ou USER_NOT_FOUND (o usuário da sessão não existe mais).",
);

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
  /** One quote line of the list. */
  quoteRow: z.object({
    id: z.string().describe("ID do orçamento."),
    name: z.string().describe("Nome de quem pediu."),
    company: z.string().describe("Empresa informada."),
    email: z.string().describe("E-mail de contato."),
    telephone: z.string().describe("Telefone de contato (só dígitos)."),
    fleet_size: z
      .enum(["1-5", "6-15", "16-30", "31-50", "51-100", "101+"])
      .describe("Tamanho da frota informado."),
    message: z.string().nullable().describe("Mensagem de quem pediu."),
    status: z
      .enum(["PENDING", "CONTACTED", "CLOSED", "CONVERTED"])
      .describe("Estágio do orçamento."),
    contacted_at: z
      .union([z.string(), z.date()])
      .nullable()
      .describe("Quando passou a Contatado ou Fechado."),
    notes: z.string().nullable().describe("Anotações internas."),
    created_at: z.union([z.string(), z.date()]).describe("Recebido em."),
    updated_at: z.union([z.string(), z.date()]).describe("Última alteração."),
  }),
  /** The list's `meta.searchMeta`, as summarizeQuoteList builds it. */
  quoteListSearchMeta: searchMetaDoc(
    {
      total: z
        .number()
        .int()
        .describe("Orçamentos da busca e dos filtros (o cartão de total)."),
      pending: z
        .number()
        .int()
        .describe("Pendentes — com a busca e o filtro de frota, sem o de estágio."),
      contacted: z
        .number()
        .int()
        .describe("Contatados — com a busca e o filtro de frota, sem o de estágio."),
      closed: z
        .number()
        .int()
        .describe("Fechados — com a busca e o filtro de frota, sem o de estágio."),
      converted: z
        .number()
        .int()
        .describe("Convertidos — com a busca e o filtro de frota, sem o de estágio."),
    },
    ["status", "fleet_size"],
  ),
  // The error handler's own shape. The previous 400 demanded `issues`, which
  // a malformed body does not carry, and the 429 invented `statusCode` and
  // `error` fields the handler never sends.
  validationError: errorResponse,
  rateLimitExceeded: errorResponse,
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  // Grouped errors by route. Every body carries `code` (decision 11.3);
  // the session user who no longer exists is 404 USER_NOT_FOUND.
  listQuoteErrors: errorResponse.describe(
    "VALIDATION_ERROR: ordenação ou filtro fora do que a lista oferece (`sort`, `status`, `fleet_size`).",
  ),
  listQuoteForbiddenErrors: masterOnly,
  listQuoteNotFoundErrors: errorResponse.describe(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  updateQuoteStatusErrors: errorResponse.describe(
    "VALIDATION_ERROR: ID, estágio ou anotações recusados (issues diz qual).",
  ),
  updateQuoteStatusForbiddenErrors: masterOnly,
  updateQuoteStatusNotFoundErrors: quoteNotFound,

  deleteQuoteErrors: errorResponse.describe(
    "VALIDATION_ERROR: o ID do pedido não é um UUID.",
  ),
  deleteQuoteForbiddenErrors: masterOnly,
  deleteQuoteNotFoundErrors: quoteNotFound,
};

export { quoteSchemas, quoteResponses };
