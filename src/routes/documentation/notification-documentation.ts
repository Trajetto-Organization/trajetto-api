import { z } from "zod";

import { updateNotificationPreferencesSchema } from "@/schemas/notification-preferences-schema";

const preferenceRow = z.object({
  category: z
    .enum(["FINES", "MAINTENANCE", "FINANCE", "TASKS", "ACCOUNT"])
    .describe("Categoria de notificação"),
  inApp: z.boolean().describe("Receber no app"),
  email: z.boolean().describe("Receber por e-mail"),
  whatsapp: z.boolean().describe("Receber por WhatsApp"),
  isDefault: z
    .boolean()
    .describe(
      "True enquanto o usuário nunca salvou esta categoria (herdando os toggles globais)",
    ),
});

const notificationSchemas = {
  registerPushToken: z.object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .describe("Expo push token do dispositivo (ExponentPushToken[...])"),
    platform: z.enum(["android", "ios"]).describe("Plataforma do dispositivo"),
  }),
  removePushToken: z.object({
    token: z.string().min(1).max(4096).describe("Expo push token a remover"),
  }),
  createNotification: z.object({
    userId: z.string().uuid().describe("ID do usuário destinatário"),
    type: z.string().describe("Tipo de notificação"),
    title: z.string().describe("Título da notificação"),
    message: z.string().describe("Conteúdo da notificação"),
    link: z.string().optional().describe("Link opcional para redirecionar"),
    entityId: z.string().optional().describe("ID da entidade relacionada"),
    shouldSendEmail: z.boolean().optional().describe("Se deve enviar email"),
  }),
  listNotificationsQuery: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de notificações a retornar"),
    includeRead: z
      .string()
      .optional()
      .describe("Se deve incluir notificações já lidas"),
  }),
  listNotificationsCursorQuery: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de notificações a retornar (padrão: 20)"),
    includeRead: z
      .string()
      .optional()
      .describe("Se deve incluir notificações já lidas (padrão: true)"),
    cursor: z
      .string()
      .optional()
      .describe("ID da última notificação da página anterior para paginação"),
  }),
  notificationIdParam: z.object({
    notificationId: z.string().uuid().describe("ID da notificação"),
  }),
  updatePreferences: updateNotificationPreferencesSchema,
};

const notificationResponses = {
  notificationCreated: z.object({
    message: z.string().default("Notificação criada com sucesso"),
    notification: z.object({
      id: z.string(),
      userId: z.string(),
      type: z.string(),
      title: z.string(),
      message: z.string(),
      link: z.string().optional(),
      read: z.boolean(),
      entityId: z.string().optional(),
      businessId: z.string(),
      created_at: z.union([z.string(), z.date()]),
      updated_at: z.union([z.string(), z.date()]),
    }),
  }),
  notificationsStreamDescription: z.object({
    description: z
      .string()
      .default(
        "NDJSON stream. First line contains meta object with {total, unread, nextCursor, hasMore}. Subsequent lines are notification objects.",
      ),
  }),
  notificationMarkedAsRead: z.object({
    message: z.string().default("Notificação marcada como lida!"),
    notification: z.object({
      id: z.string(),
      read: z.boolean().default(true),
    }),
  }),
  notificationDeleted: z.object({
    message: z.string().default("Notificação excluída com sucesso!"),
  }),
  unreadCount: z.object({
    count: z.number().describe("Número de notificações não lidas"),
  }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  // Error responses for list routes (status 400)
  listNotificationsErrors: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  // Error responses for mark as read (status 400)
  markAsReadErrors: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  // Error responses for mark as read (status 403)
  markAsReadForbiddenError: z.object({
    message: z.string().default("Acesso não autorizado à esta notificação!"),
  }),

  // Error responses for mark as read (status 404)
  markAsReadNotFoundError: z.object({
    message: z
      .string()
      .default("Notificação não encontrada! Por favor, tente novamente."),
  }),

  // Error responses for delete (status 400)
  deleteNotificationErrors: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  // Error responses for delete (status 403)
  deleteNotificationForbiddenError: z.object({
    message: z.string().default("Acesso não autorizado à esta notificação!"),
  }),

  // Error responses for delete (status 404)
  deleteNotificationNotFoundError: z.object({
    message: z
      .string()
      .default("Notificação não encontrada! Por favor, tente novamente."),
  }),
};

const allNotificationResponses = {
  ...notificationResponses,

  allNotificationsMarkedAsRead: z.object({
    message: z.string().describe("Resumo da operação"),
    count: z.number().describe("Quantidade de notificações marcadas"),
  }),
  pushTokenChanged: z.object({
    message: z.string().describe("Resumo da operação"),
  }),
  preferencesRetrieved: z.object({
    preferences: z.array(preferenceRow),
  }),
  preferencesUpdated: z.object({
    message: z.string().default("Preferências de notificação atualizadas!"),
  }),
};

export {
  notificationSchemas,
  allNotificationResponses as notificationResponses,
};
