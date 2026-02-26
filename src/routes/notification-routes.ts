import { FastifyInstance } from "fastify";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { ListUserNotificationsCursorController } from "@/modules/notification/usecases/list-user-notifications-cursor/list-user-notifications-cursor-controller";
import { MarkNotificationAsReadController } from "@/modules/notification/usecases/mark-notification-as-read/mark-notification-as-read-controller";

import { DeleteNotificationController } from "@/modules/notification/usecases/delete-notification/delete-notification-controller";
import { CountUnreadNotificationsController } from "@/modules/notification/usecases/count-unread-notifications/count-unread-notifications-controller";

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
}

export { notificationRoutes };
