import { FastifyInstance } from "fastify";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import { ConnectQRCodeController } from "@/modules/whatsapp/usecases/connect-qrcode/connect-qrcode-controller";
import { WhatsAppStatusController } from "@/modules/whatsapp/usecases/whatsapp-status/whatsapp-status-controller";

import { WhatsAppWebhookController } from "@/modules/whatsapp/usecases/webhook/whatsapp-webhook-controller";
import { WhatsAppSettingsController } from "@/modules/whatsapp/usecases/manage-settings/whatsapp-settings-controller";

import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

const connectQRCodeController = new ConnectQRCodeController();
const whatsAppStatusController = new WhatsAppStatusController();

const webhookController = new WhatsAppWebhookController();
const settingsController = new WhatsAppSettingsController();

async function whatsappRoutes(app: FastifyInstance) {
  app.get(
    "/settings",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        tags: ["WhatsApp - Configurações"],
        summary: "Obter configurações WhatsApp",
        description: "Obtém configurações atuais do WhatsApp do usuário",
        security: [{ bearerAuth: [] }],
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
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        tags: ["WhatsApp - Configurações"],
        summary: "Atualizar configurações WhatsApp",
        description:
          "Habilita/desabilita WhatsApp e configura número de telefone",
        security: [{ bearerAuth: [] }],
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
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        tags: ["WhatsApp - Status"],
        summary: "Verificar status da conexão WhatsApp",
        description: "Verifica e atualiza o status atual da conexão WhatsApp",
        security: [{ bearerAuth: [] }],
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
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        tags: ["WhatsApp - Conexão"],
        summary: "Obter QR Code para conexão WhatsApp",
        description: "Gera QR Code para conectar WhatsApp via escaneamento",
        security: [{ bearerAuth: [] }],
      },
    },
    connectQRCodeController.handle,
  );

  app.post(
    "/webhook/:instanceName",
    webhookController.handle.bind(webhookController),
  );
}

export { whatsappRoutes };
