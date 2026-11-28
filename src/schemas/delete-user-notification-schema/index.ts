import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteUserNotificationSchema = z.object({
  notificationId: z
    .string(fieldError({ required: "ID da notificação é obrigatório!" }))
    .uuid("ID da notificação é inválido."),
});

export { updateDeleteUserNotificationSchema };
