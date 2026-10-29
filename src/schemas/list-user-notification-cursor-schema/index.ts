import { z } from "zod";

import { MAX_PAGE_SIZE } from "@/shared/pagination/page-size";

const listUserNotificationsCursorSchema = z.object({
  // The one cursor-paginated list that never got the ceiling the others have:
  // its `parseInt` went straight into `take: limit + 1`.
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 20))
    .refine(
      (val) => Number.isInteger(val) && val >= 1 && val <= MAX_PAGE_SIZE,
      `O limite deve ser um inteiro entre 1 e ${MAX_PAGE_SIZE}.`,
    ),
  includeRead: z
    .string()
    .optional()
    .transform((val) => val !== "false"), // Default to true
  cursor: z.string().optional(), // ID of last notification from previous page
});

export { listUserNotificationsCursorSchema };
