import { FastifyInstance } from "fastify";

import { SearchAddressController } from "@/modules/address-search/usecases/search-address/search-address-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";
import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  addressSearchResponses,
  addressSearchSchemas,
} from "./documentation/address-search-documentation";
import { errorResponse } from "./documentation/common-responses";

const searchAddressController = new SearchAddressController();

/**
 * The panel's address search (plan pin-search). Today only "Fixar no mapa"
 * on the route page asks it, so it sits behind what that page writes with:
 * the deliveries module and `delivery_manage:write`, never a driver — the
 * app does not search, and a driver token must not spend the company's
 * day. The company is the path's (the global tenant guard compares it with
 * the token); its cache and its count are that company's.
 */
async function addressSearchRoutes(app: FastifyInstance) {
  app.get(
    "/:businessId",
    {
      // Per user (the limiter keys by the token's user): a person typing
      // with a 400 ms pause asks far fewer.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        verifyModuleEnabled("DELIVERIES"),
        verifyPermission("delivery_manage", "write", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["address-search"],
        summary: "Buscar um endereço ou um lugar para fixar no mapa",
        description:
          'A busca do "Fixar no mapa" da página da rota: sugestões de endereço para o que está sendo digitado, do OpenStreetMap pelo provedor de geocodificação da plataforma (LocationIQ em staging e produção), sem que a chave saia do servidor. Só sugere: o ponto é gravado depois, por `PATCH /route/set-delivery-location/:deliveryId/business/:businessId`. Com `city` e `uf` (a cidade da entrega), busca nessa cidade e a põe primeiro; sem elas, no Brasil todo. `viewbox` (a área das paradas) aproxima os resultados de perto sem esconder os de longe. Só resultados no Brasil, cada lugar uma vez, com o nível de precisão. Cada empresa tem o seu cache de até 48 h (`cached: true` não gasta busca), o seu limite do dia (`ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT`, padrão 150) e divide o da plataforma (`ADDRESS_SEARCH_DAILY_BUDGET`, padrão 1.000); estourado, 429 ADDRESS_SEARCH_DAILY_LIMIT até a meia-noite UTC. A busca divide com a localização automática das entregas a vaga do provedor (uma chamada por segundo, 50 por minuto): sem vaga em cerca de um segundo, 503 ADDRESS_SEARCH_BUSY com `retry-after`. Desligada, pausada ou com o provedor fora, 503 ADDRESS_SEARCH_UNAVAILABLE. Até 30 buscas por minuto por usuário. O texto digitado vai ao provedor e nunca é gravado em log; no cache, a chave é um HMAC da busca e as sugestões ficam cifradas (AES-256-GCM). Motorista recebe 403 PERMISSION_DENIED.',
        params: addressSearchSchemas.businessIdParam,
        querystring: addressSearchSchemas.query,
        response: {
          200: addressSearchResponses.search,
          400: addressSearchResponses.validation,
          401: errorResponse,
          403: errorResponse,
          429: addressSearchResponses.dailyLimit,
          500: addressSearchResponses.internalServerError,
          503: addressSearchResponses.unavailable,
        },
      },
    },
    searchAddressController.handle,
  );
}

export { addressSearchRoutes };
