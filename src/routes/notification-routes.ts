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
        summary: "Stream user notifications (NDJSON)",
        description:
          "Retrieve notifications as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {total, unread, nextCursor, hasMore}}. " +
          "Subsequent lines are individual notification objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: notificationSchemas.listNotificationsCursorQuery,
        response: {
          200: notificationResponses.notificationsStreamDescription,
          400: notificationResponses.listNotificationsErrors,
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
        summary: "Count unread notifications",
        description:
          "Get the total count of unread notifications for the authenticated user",
        response: {
          200: notificationResponses.unreadCount,
          400: notificationResponses.listNotificationsErrors,
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
        summary: "Mark notification as read",
        description: "Mark a specific notification as read by its ID",
        params: notificationSchemas.notificationIdParam,
        response: {
          200: notificationResponses.notificationMarkedAsRead,
          400: notificationResponses.markAsReadErrors,
          403: notificationResponses.markAsReadForbiddenError,
          404: notificationResponses.markAsReadNotFoundError,
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
        summary: "Delete notification",
        description: "Permanently delete a specific notification by its ID",
        params: notificationSchemas.notificationIdParam,
        response: {
          200: notificationResponses.notificationDeleted,
          400: notificationResponses.deleteNotificationErrors,
          403: notificationResponses.deleteNotificationForbiddenError,
          404: notificationResponses.deleteNotificationNotFoundError,
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
        summary: "Mark all notifications as read",
        description:
          "Mark every unread notification of the authenticated user as read",
        response: {
          200: notificationResponses.allNotificationsMarkedAsRead,
          400: notificationResponses.listNotificationsErrors,
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
        summary: "Register the device's Expo push token",
        description:
          "Registers (or reassigns to the authenticated user) the Expo push token of the mobile device. The PUSH pipeline channel only fans out to users with a registered token.",
        body: notificationSchemas.registerPushToken,
        response: {
          200: notificationResponses.pushTokenChanged,
          400: notificationResponses.listNotificationsErrors,
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
        summary: "Unregister the device's Expo push token",
        description:
          "Best-effort logout cleanup — dead tokens are also pruned automatically when the provider reports DeviceNotRegistered.",
        body: notificationSchemas.removePushToken,
        response: {
          200: notificationResponses.pushTokenChanged,
          400: notificationResponses.listNotificationsErrors,
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
        summary: "Get notification preferences",
        description:
          "Per-category channel preferences for the authenticated user. Categories never saved return the user's legacy global toggles as defaults (isDefault: true)",
        response: {
          200: notificationResponses.preferencesRetrieved,
          400: notificationResponses.listNotificationsErrors,
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
        summary: "Update notification preferences",
        description:
          "Upsert per-category channel preferences. Mandatory account notices are always delivered in-app regardless of these settings; WhatsApp additionally requires a configured phone number",
        body: notificationSchemas.updatePreferences,
        response: {
          200: notificationResponses.preferencesUpdated,
          400: notificationResponses.listNotificationsErrors,
          500: notificationResponses.internalServerError,
        },
      },
    },
    notificationPreferencesController.updatePreferences,
  );
}

export { notificationRoutes };
