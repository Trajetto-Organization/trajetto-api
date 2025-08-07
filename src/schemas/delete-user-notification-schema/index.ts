import { z } from "zod";

const updateDeleteUserNotificationSchema = z.object({
  notificationId: z.string().min(1, "O ID da notificação é obrigatória!"),
});

export { updateDeleteUserNotificationSchema };
