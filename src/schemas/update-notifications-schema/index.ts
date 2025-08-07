import { z } from "zod";

const updateNotificationsSchema = z.object({
  notification_enabled: z.boolean({
    required_error: "Estado de notificação é obrigatório",
  }),
});

export { updateNotificationsSchema };
