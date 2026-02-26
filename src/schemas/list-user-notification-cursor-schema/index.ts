import { z } from "zod";

const listUserNotificationsCursorSchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 20)),
  includeRead: z
    .string()
    .optional()
    .transform((val) => val !== "false"), // Default to true
  cursor: z.string().optional(), // ID of last notification from previous page
});

export { listUserNotificationsCursorSchema };
