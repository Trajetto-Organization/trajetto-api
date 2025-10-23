import { FastifyInstance } from "fastify";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { ConnectQRCodeController } from "@/modules/whatsapp/usecases/connect-qrcode/connect-qrcode-controller";
import { WhatsAppStatusController } from "@/modules/whatsapp/usecases/whatsapp-status/whatsapp-status-controller";

import { WhatsAppWebhookController } from "@/modules/whatsapp/usecases/webhook/whatsapp-webhook-controller";
import { WhatsAppSettingsController } from "@/modules/whatsapp/usecases/manage-settings/whatsapp-settings-controller";

import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

import {
  whatsappSchemas,
  whatsappResponses,
} from "./documentation/whatsapp-documentation";

const connectQRCodeController = new ConnectQRCodeController();
const whatsAppStatusController = new WhatsAppStatusController();

const webhookController = new WhatsAppWebhookController();
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
          "Retrieve current WhatsApp configuration settings for the authenticated user",
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
          "Enable/disable WhatsApp notifications and configure phone number settings",
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

  app.get(
    "/status",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 5 }),
      },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["whatsapp"],
        summary: "Check WhatsApp connection status",
        description:
          "Verify and update the current WhatsApp connection status for the user",
        response: {
          200: whatsappResponses.statusRetrieved,
          400: whatsappResponses.statusErrors,
          500: whatsappResponses.internalServerError,
        },
      },
    },
    whatsAppStatusController.handle,
  );

  app.get(
    "/connect/qrcode",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 5 }),
      },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["whatsapp"],
        summary: "Generate QR code for WhatsApp connection",
        description:
          "Generate a QR code that can be scanned to connect WhatsApp to the system",
        response: {
          200: whatsappResponses.qrCodeGenerated,
          400: whatsappResponses.qrCodeErrors,
          500: whatsappResponses.internalServerError,
        },
      },
    },
    connectQRCodeController.handle,
  );

  app.post(
    "/webhook/:instanceName",
    {
      config: {
        rateLimit: getRateLimiterConfig({
          max: 1000, // 1000 requests per minute - High limit for Evolution API bursts
        }),
      },
      logLevel: "silent", // Disable HTTP logs for webhook endpoint (reduces log spam from Evolution API heartbeats)
      schema: {
        tags: ["whatsapp"],
        summary: "WhatsApp webhook endpoint",
        description:
          "Receive webhook events from WhatsApp service for message and status updates",
      },
    },
    webhookController.handle.bind(webhookController),
  );
}

export { whatsappRoutes };
