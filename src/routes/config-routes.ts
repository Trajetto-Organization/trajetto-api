import { FastifyInstance } from "fastify";

import { GetMapConfigController } from "@/modules/config/usecases/get-map-config/get-map-config-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { configResponses } from "./documentation/config-documentation";

const getMapConfigController = new GetMapConfigController();

/**
 * Settings a client reads from the API instead of carrying them in its
 * bundle. Today: the app's base map (wave 5), whose provider URL may hold a
 * key that an OTA bundle would hand to anyone who unpacks the APK.
 */
async function configRoutes(app: FastifyInstance) {
  app.get(
    "/map",
    {
      // A session and nothing else: the platform's provider, the same one
      // the web gives every browser, is no company's data.
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["config"],
        summary: "O mapa de fundo dos mapas do app",
        description:
          'O provedor de tiles do mapa ao vivo do app (onda 5), com as mesmas variáveis e as mesmas regras do mapa da web: `MAP_TILE_URL` e `MAP_TILE_ATTRIBUTION` e, para o tema escuro, `MAP_TILE_URL_DARK` e `MAP_TILE_ATTRIBUTION_DARK`, definidas no Environment da API com os valores da web. `url` é um modelo do Leaflet (https; http só em desenvolvimento) e pode levar a chave do provedor; `attribution` é texto já escapado para HTML, nunca marcação (sem crédito configurado: "© provedor de mapas"). `dark` só existe com o estilo escuro configurado; sem crédito próprio, repete o do mapa claro. Sem provedor, `tiles` é null fora de desenvolvimento: o app desenha os marcadores sem mapa de fundo e avisa. Em desenvolvimento, sem provedor, vem o OpenStreetMap público, cuja política de uso proíbe este volume em staging e produção. Qualquer sessão lê, inclusive o motorista e o MASTER: não é dado de empresa. Responde com `Cache-Control: private, max-age=300`: o valor só muda com um deploy.',
        response: {
          200: configResponses.mapConfig,
          500: configResponses.internalServerError,
        },
      },
    },
    getMapConfigController.handle,
  );
}

export { configRoutes };
