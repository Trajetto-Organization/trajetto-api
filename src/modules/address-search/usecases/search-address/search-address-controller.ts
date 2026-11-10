import { FastifyReply, FastifyRequest } from "fastify";

import { ServiceBusyError } from "@/shared/errors/service-busy-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import {
  addressSearchQuerySchema,
  parseViewbox,
} from "../../schemas/address-search-schemas";
import { searchAddressUseCase } from "./search-address-runtime";

/**
 * GET /address-search/:businessId. The person typing again aborts the
 * browser's request; the reply's socket closing before an answer is that,
 * and the search stops there: no slot taken, no call made, nothing spent.
 *
 * The listener comes only with the handler, after the guards (the session,
 * the company, the module, the permission): a request given up while they
 * ran closed its socket before anybody listened, and is answered here
 * without searching.
 */
class SearchAddressController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const query = addressSearchQuerySchema.parse(request.query);

    if (reply.raw.destroyed || request.raw.socket?.destroyed) {
      return reply.status(499).send();
    }

    const gone = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) gone.abort();
    };

    reply.raw.once("close", onClose);

    const result = await searchAddressUseCase().execute({
      businessId,
      query: query.q,
      hint: query.city && query.uf ? { city: query.city, uf: query.uf } : null,
      viewbox: query.viewbox ? parseViewbox(query.viewbox) : null,
      limit: query.limit,
      signal: gone.signal,
    });

    reply.raw.off("close", onClose);

    switch (result.kind) {
      case "OK":
        return reply.status(200).send({
          data: {
            results: result.results,
            weak: result.weak,
            scope: result.scope,
            cached: result.cached,
          },
        });

      case "DAILY_LIMIT":
        if (result.scope === "BUSINESS") {
          throw new ServiceBusyError(
            "A sua empresa atingiu o limite de buscas de endereço de hoje. Clique no mapa onde fica o endereço.",
            "ADDRESS_SEARCH_DAILY_LIMIT",
            result.retryAfterSeconds,
            429,
          );
        }

        throw new ServiceBusyError(
          "A busca de endereço atingiu o limite de hoje. Clique no mapa onde fica o endereço.",
          "ADDRESS_SEARCH_DAILY_LIMIT",
          result.retryAfterSeconds,
          429,
        );

      case "BUSY":
        throw new ServiceBusyError(
          "A busca de endereço está ocupada agora. Tente de novo em instantes.",
          "ADDRESS_SEARCH_BUSY",
          result.retryAfterSeconds,
        );

      case "UNAVAILABLE":
        throw new ServiceBusyError(
          "A busca de endereço está indisponível agora. Clique no mapa onde fica o endereço.",
          "ADDRESS_SEARCH_UNAVAILABLE",
          result.retryAfterSeconds,
        );

      case "ABORTED":
        // Nobody is reading: 499, nginx's "client closed request", so the
        // request log tells it from a refusal.
        return reply.status(499).send();
    }
  }
}

export { SearchAddressController };
