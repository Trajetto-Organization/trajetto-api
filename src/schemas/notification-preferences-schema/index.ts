import { z } from "zod";

// SYSTEM is deliberately not accepted: it has no user-facing deliveries, so
// letting a client write rows for it would only create dead data.
const userFacingCategorySchema = z.enum([
  "FINES",
  "MAINTENANCE",
  "FINANCE",
  "TASKS",
  "ACCOUNT",
]);

const updateNotificationPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        category: userFacingCategorySchema.describe(
          "Which notification category this row configures",
        ),
        inApp: z.boolean().describe("Receive in the app's notification list"),
        email: z.boolean().describe("Receive by e-mail"),
        whatsapp: z
          .boolean()
          .describe(
            "Receive by WhatsApp — still requires a configured phone number",
          ),
      }),
    )
    .min(1, "Informe ao menos uma preferência.")
    .max(16, "Número de preferências inválido."),
});

export { updateNotificationPreferencesSchema, userFacingCategorySchema };
