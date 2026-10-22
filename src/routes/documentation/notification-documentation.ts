import { z } from "zod";

import { updateNotificationPreferencesSchema } from "@/schemas/notification-preferences-schema";
import { errorResponse } from "./common-responses";
import { cursorMeta } from "./ndjson";

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
  // The bell's first line: a real total (not the cursor feeds' zero) and the
  // unread count next to the cursor.
  notificationStreamMeta: cursorMeta(
    {
      unread: z.number().int().describe("Não lidas do usuário, para o badge."),
    },
    z.number().int().describe("Total de notificações do filtro."),
  ),
  /** One line of the bell's stream: the row as stored, no relations. */
  notificationStreamRow: z.object({
    id: z.string(),
    type: z.string().describe("Origem: service-order, vehicle, delivery…"),
    title: z.string(),
    message: z.string(),
    link: z.string().nullable(),
    read: z.boolean(),
    entityId: z.string().nullable(),
    businessId: z.string().nullable(),
    userId: z.string(),
    deliveryId: z.string().nullable(),
    created_at: z.union([z.string(), z.date()]),
    updated_at: z.union([z.string(), z.date()]),
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

  // Every refusal carries `code` (decision 11.3); the session user who no
  // longer exists is 404 USER_NOT_FOUND, never a 400.
  validationError: errorResponse.describe(
    "VALIDATION_ERROR: parâmetro, consulta ou corpo recusado (issues diz qual).",
  ),
  sessionUserNotFound: errorResponse.describe(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),
  notificationNotFound: errorResponse.describe(
    "NOTIFICATION_NOT_FOUND (inexistente ou de outra pessoa — a mesma resposta) ou USER_NOT_FOUND (o usuário da sessão não existe mais).",
  ),
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
    // Decision 14.6: the web's operations alert sound, per person.
    opsAlert: z.object({
      sound: z
        .boolean()
        .describe("Tocar som nos alertas da operação (balão flutuante)."),
    }),
  }),
  preferencesUpdated: z.object({
    message: z.string().default("Preferências de notificação atualizadas!"),
  }),
};

export {
  notificationSchemas,
  allNotificationResponses as notificationResponses,
};
