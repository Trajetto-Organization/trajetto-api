import { FastifyInstance } from "fastify";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";

import { ListUserNotificationsController } from "@/modules/notification/usecases/list-user-notifications/list-user-notifications-controller";
import { MarkNotificationAsReadController } from "@/modules/notification/usecases/mark-notification-as-read/mark-notification-as-read-controller";

import { MarkAllNotificationsAsReadController } from "@/modules/notification/usecases/mark-all-notifications-as-read/mark-all-notifications-as-read-controller";
import { DeleteNotificationController } from "@/modules/notification/usecases/delete-notification/delete-notification-controller";

import { CountUnreadNotificationsController } from "@/modules/notification/usecases/count-unread-notifications/count-unread-notifications-controller";
import {
  notificationResponses,
  notificationSchemas,
} from "./documentation/notification-documentation";

const listUserNotificationsController = new ListUserNotificationsController();

const markNotificationAsReadController = new MarkNotificationAsReadController();
const markAllNotificationsAsReadController =
  new MarkAllNotificationsAsReadController();

const deleteNotificationController = new DeleteNotificationController();
const countUnreadNotificationsController =
  new CountUnreadNotificationsController();

async function notificationRoutes(app: FastifyInstance) {
  app.get(
    "/list",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "List user notifications",
        description: "Retrieve a paginated list of notifications for the authenticated user with optional filtering",
        querystring: notificationSchemas.listNotificationsQuery,
        response: {
          200: notificationResponses.notificationsList,
          500: notificationResponses.internalServerError,
        },
      },
    },
    listUserNotificationsController.handle,
  );

  app.get(
    "/unread-count",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Count unread notifications",
        description: "Get the total count of unread notifications for the authenticated user",
        response: {
          200: notificationResponses.unreadCount,
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
          500: notificationResponses.internalServerError,
        },
      },
    },
    markNotificationAsReadController.handle,
  );

  app.patch(
    "/read-all",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["notification"],
        summary: "Mark all notifications as read",
        description: "Mark all notifications as read for the authenticated user",
        response: {
          200: notificationResponses.allNotificationsMarkedAsRead,
          500: notificationResponses.internalServerError,
        },
      },
    },
    markAllNotificationsAsReadController.handle,
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
          500: notificationResponses.internalServerError,
        },
      },
    },
    deleteNotificationController.handle,
  );
}

export { notificationRoutes };
