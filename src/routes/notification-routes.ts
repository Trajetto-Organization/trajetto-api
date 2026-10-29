import { FastifyInstance } from "fastify";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { ListUserNotificationsCursorController } from "@/modules/notification/usecases/list-user-notifications-cursor/list-user-notifications-cursor-controller";
import { MarkNotificationAsReadController } from "@/modules/notification/usecases/mark-notification-as-read/mark-notification-as-read-controller";

import { DeleteNotificationController } from "@/modules/notification/usecases/delete-notification/delete-notification-controller";
import { CountUnreadNotificationsController } from "@/modules/notification/usecases/count-unread-notifications/count-unread-notifications-controller";

import { MarkAllNotificationsReadController } from "@/modules/notification/usecases/mark-all-notifications-read/mark-all-notifications-read-controller";
import { NotificationPreferencesController } from "@/modules/notification/usecases/manage-preferences/notification-preferences-controller";
import {
  RegisterPushTokenController,
  RemovePushTokenController,
} from "@/modules/notification/usecases/manage-push-token/manage-push-token-controller";

import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

import {
  notificationResponses,
  notificationSchemas,
} from "./documentation/notification-documentation";
import { ndjsonCursor } from "./documentation/ndjson";

const listUserNotificationsCursorController =
  new ListUserNotificationsCursorController();

const markNotificationAsReadController = new MarkNotificationAsReadController();
const deleteNotificationController = new DeleteNotificationController();

const countUnreadNotificationsController =
  new CountUnreadNotificationsController();

const registerPushTokenController = new RegisterPushTokenController();
const removePushTokenController = new RemovePushTokenController();

const markAllNotificationsReadController =
  new MarkAllNotificationsReadController();

const notificationPreferencesController =
  new NotificationPreferencesController();

async function notificationRoutes(app: FastifyInstance) {
  app.get(
    "/stream",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Lista as notificações do usuário (NDJSON, cursor)",
        description:
          "Responde em application/x-ndjson, paginado por cursor. " +
          "A primeira linha traz o envelope {meta: {total, searchMeta: {unread, nextCursor, hasMore}}}; " +
          "cada linha seguinte é uma notificação. " +
          "Passe o nextCursor em `cursor` para a próxima página.",
        querystring: notificationSchemas.listNotificationsCursorQuery,
        response: {
          200: ndjsonCursor(
            notificationResponses.notificationStreamRow,
            notificationResponses.notificationStreamMeta,
          ),
          400: notificationResponses.validationError,
          404: notificationResponses.sessionUserNotFound,
          500: notificationResponses.internalServerError,
        },
      },
    },
    listUserNotificationsCursorController.handle,
  );

  app.get(
    "/unread-count",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Conta as notificações não lidas",
        description: "Total de notificações não lidas do usuário autenticado.",
        response: {
          200: notificationResponses.unreadCount,
          404: notificationResponses.sessionUserNotFound,
          500: notificationResponses.internalServerError,
        },
      },
    },
    countUnreadNotificationsController.handle,
  );

  app.patch(
    "/:notificationId/read",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Marca uma notificação como lida",
        description:
          "Marca como lida uma notificação do usuário autenticado. A notificação de outra pessoa responde o mesmo 404 NOTIFICATION_NOT_FOUND de uma que não existe.",
        params: notificationSchemas.notificationIdParam,
        response: {
          200: notificationResponses.notificationMarkedAsRead,
          400: notificationResponses.validationError,
          404: notificationResponses.notificationNotFound,
          500: notificationResponses.internalServerError,
        },
      },
    },
    markNotificationAsReadController.handle,
  );

  app.delete(
    "/:notificationId",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Exclui uma notificação",
        description:
          "Exclui de vez uma notificação do usuário autenticado. A notificação de outra pessoa responde o mesmo 404 NOTIFICATION_NOT_FOUND de uma que não existe.",
        params: notificationSchemas.notificationIdParam,
        response: {
          200: notificationResponses.notificationDeleted,
          400: notificationResponses.validationError,
          404: notificationResponses.notificationNotFound,
          500: notificationResponses.internalServerError,
        },
      },
    },
    deleteNotificationController.handle,
  );

  app.patch(
    "/read-all",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 10 }),
      },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Marca todas as notificações como lidas",
        description:
          "Marca como lidas todas as notificações não lidas do usuário autenticado.",
        response: {
          200: notificationResponses.allNotificationsMarkedAsRead,
          404: notificationResponses.sessionUserNotFound,
          500: notificationResponses.internalServerError,
        },
      },
    },
    markAllNotificationsReadController.handle,
  );

  app.post(
    "/push-token",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 10 }),
      },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Registra o token de push (Expo) do aparelho",
        description:
          "Registra o token de push Expo do celular (ou o transfere para o usuário autenticado). O canal PUSH só envia para quem tem token registrado.",
        body: notificationSchemas.registerPushToken,
        response: {
          200: notificationResponses.pushTokenChanged,
          400: notificationResponses.validationError,
          404: notificationResponses.sessionUserNotFound,
          500: notificationResponses.internalServerError,
        },
      },
    },
    registerPushTokenController.handle,
  );

  app.delete(
    "/push-token",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 10 }),
      },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Remove o token de push (Expo) do aparelho",
        description:
          "Limpeza no logout, sem garantia: tokens mortos também saem sozinhos quando o provedor responde DeviceNotRegistered.",
        body: notificationSchemas.removePushToken,
        response: {
          200: notificationResponses.pushTokenChanged,
          400: notificationResponses.validationError,
          404: notificationResponses.sessionUserNotFound,
          500: notificationResponses.internalServerError,
        },
      },
    },
    removePushTokenController.handle,
  );

  app.get(
    "/preferences",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Consulta as preferências de notificação",
        description:
          "Canais escolhidos por categoria para o usuário autenticado. Uma categoria nunca salva volta com os interruptores gerais antigos do usuário como padrão (isDefault: true).",
        response: {
          200: notificationResponses.preferencesRetrieved,
          404: notificationResponses.sessionUserNotFound,
          500: notificationResponses.internalServerError,
        },
      },
    },
    notificationPreferencesController.getPreferences,
  );

  app.put(
    "/preferences",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 10 }),
      },
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Atualiza as preferências de notificação",
        description:
          "Grava os canais por categoria. Os avisos obrigatórios da conta chegam sempre no app, seja qual for a escolha; o WhatsApp exige também um telefone configurado.",
        body: notificationSchemas.updatePreferences,
        response: {
          200: notificationResponses.preferencesUpdated,
          400: notificationResponses.validationError,
          404: notificationResponses.sessionUserNotFound,
          500: notificationResponses.internalServerError,
        },
      },
    },
    notificationPreferencesController.updatePreferences,
  );
}

export { notificationRoutes };
