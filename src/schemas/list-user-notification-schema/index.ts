import { z } from "zod";

const listUserNotificationsSchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 10)),
  includeRead: z
    .string()
    .optional()
    .transform((val) => val === "true"),
});

export { listUserNotificationsSchema };
