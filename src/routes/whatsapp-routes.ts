import { FastifyInstance } from "fastify";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { WhatsAppSettingsController } from "@/modules/whatsapp/usecases/manage-settings/whatsapp-settings-controller";
import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

import { errorResponse } from "./documentation/common-responses";

import {
  whatsappSchemas,
  whatsappResponses,
} from "./documentation/whatsapp-documentation";

const settingsController = new WhatsAppSettingsController();

async function whatsappRoutes(app: FastifyInstance) {
  app.get(
    "/settings",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["whatsapp"],
        summary: "Consulta a configuração do WhatsApp",
        description:
          "Se o usuário autenticado aceitou avisos por WhatsApp, o telefone que os recebe e se o servidor tem as credenciais da Meta Cloud API configuradas.",
        response: {
          200: whatsappResponses.settingsRetrieved,
          404: whatsappResponses.sessionUserNotFound,
          500: whatsappResponses.internalServerError,
        },
      },
    },
    settingsController.getSettings,
  );

  app.patch(
    "/settings",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 5 }),
      },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["whatsapp"],
        summary: "Atualiza a configuração do WhatsApp",
        description:
          "Liga ou desliga os avisos por WhatsApp do usuário autenticado e define o telefone que os recebe (Meta Cloud API oficial, sem pareamento). Ligar sem telefone: 400 WHATSAPP_NUMBER_REQUIRED. Um telefone já usado por outro usuário com o WhatsApp ligado: 409 WHATSAPP_PHONE_TAKEN.",
        body: whatsappSchemas.updateWhatsAppSettings,
        response: {
          200: whatsappResponses.settingsUpdated,
          400: whatsappResponses.settingsErrors,
          404: whatsappResponses.sessionUserNotFound,
          409: errorResponse.describe(
            "Telefone já usado por outro usuário (WHATSAPP_PHONE_TAKEN).",
          ),
          500: whatsappResponses.internalServerError,
        },
      },
    },
    settingsController.updateSettings,
  );
}

export { whatsappRoutes };
