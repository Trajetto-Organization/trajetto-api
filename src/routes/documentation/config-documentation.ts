import { z } from "zod";

import { internalErrorResponse } from "./common-responses";

/**
 * What the clients read from the API to set themselves up (wave 5: the app's
 * base map). Platform settings, the same for every session: no company data
 * ever goes here.
 */

const tileSource = z.object({
  url: z
    .string()
    .describe(
      "Modelo de tiles do Leaflet: https (http só em desenvolvimento) com {z}, {x} e {y}; {s} (subdomínio) e {r} opcionais. Pode levar a chave do provedor, restrita por origem no painel dele.",
    ),
  attribution: z
    .string()
    .describe(
      "Crédito do provedor em texto já escapado para HTML (`&`, `<`, `>`, aspas e apóstrofo viram entidades): nunca traz marcação.",
    ),
});

const configResponses = {
  mapConfig: z.object({
    tiles: tileSource
      .extend({
        dark: tileSource
          .optional()
          .describe(
            "O estilo escuro do provedor, só quando `MAP_TILE_URL_DARK` está definida; sem crédito próprio, repete o do mapa claro. Ausente: o cliente recolore os tiles claros com o filtro CSS da web.",
          ),
      })
      .nullable()
      .describe(
        "O mapa de fundo. Null fora de desenvolvimento sem provedor configurado: o cliente desenha os marcadores sem mapa de fundo e avisa.",
      ),
  }),
  internalServerError: internalErrorResponse,
};

export { configResponses };
