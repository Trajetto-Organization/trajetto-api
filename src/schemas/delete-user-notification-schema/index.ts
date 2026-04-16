import { z } from "zod";

const updateDeleteUserNotificationSchema = z.object({
  notificationId: z
    .string({ required_error: "ID da notificação é obrigatório!" })
    .uuid("ID da notificação é inválido."),
});

export { updateDeleteUserNotificationSchema };
