import { z } from "zod";

const notificationSchemas = {
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
  notificationIdParam: z.object({
    notificationId: z.string().uuid().describe("ID da notificação"),
  }),
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
      created_at: z.string(),
      updated_at: z.string(),
    }),
  }),
  notificationsList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        userId: z.string(),
        type: z.string(),
        title: z.string(),
        message: z.string(),
        link: z.string().optional(),
        read: z.boolean(),
        entityId: z.string().optional(),
        businessId: z.string().nullable(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
    total: z.number(),
    unread: z.number(),
  }),
  notificationMarkedAsRead: z.object({
    message: z.string().default("Notificação marcada como lida"),
    notification: z.object({
      id: z.string(),
      read: z.boolean().default(true),
    }),
  }),
  allNotificationsMarkedAsRead: z.object({
    message: z
      .string()
      .default("Todas as notificações foram marcadas como lidas"),
  }),
  notificationDeleted: z.object({
    message: z.string().default("Notificação excluída com sucesso"),
  }),
  unreadCount: z.object({
    count: z.number().describe("Número de notificações não lidas"),
  }),
  internalServerError: z.object({
    message: z.string().default("Erro interno do servidor"),
  }),
};

export { notificationSchemas, notificationResponses };
