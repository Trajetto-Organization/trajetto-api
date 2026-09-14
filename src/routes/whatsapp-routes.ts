import { FastifyInstance } from "fastify";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { WhatsAppSettingsController } from "@/modules/whatsapp/usecases/manage-settings/whatsapp-settings-controller";
import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

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
        summary: "Get WhatsApp settings",
        description:
          "Retrieve the authenticated user's WhatsApp notification opt-in and phone number, plus whether the server has Meta Cloud API credentials configured",
        response: {
          200: whatsappResponses.settingsRetrieved,
          400: whatsappResponses.resourceNotFound,
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
        summary: "Update WhatsApp settings",
        description:
          "Enable/disable WhatsApp notifications for the authenticated user and set the phone number that receives them (official Meta Cloud API — no pairing step)",
        body: whatsappSchemas.updateWhatsAppSettings,
        response: {
          200: whatsappResponses.settingsUpdated,
          400: whatsappResponses.settingsErrors,
          500: whatsappResponses.internalServerError,
        },
      },
    },
    settingsController.updateSettings,
  );
}

export { whatsappRoutes };
