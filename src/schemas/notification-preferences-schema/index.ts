import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

// SYSTEM is deliberately not accepted: it has no user-facing deliveries, so
// letting a client write rows for it would only create dead data. That holds
// again since 14/11/2026, when the plan and webhook notices (mandatory, with
// e-mail and WhatsApp) moved from SYSTEM to ACCOUNT; preference-catalog.test.ts
// keeps any channel out of SYSTEM. Which of these five a person may save is
// the role's catalog, applied by the use case (rows outside it are dropped).
const userFacingCategorySchema = z.enum([
  "FINES",
  "MAINTENANCE",
  "FINANCE",
  "TASKS",
  "ACCOUNT",
]);

const updateNotificationPreferencesSchema = z
  .object({
    ...tenantLockedShape,
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
      .max(16, "Número de preferências inválido.")
      // Optional since decision 14.6: a save may carry only the alert sound.
      .optional(),

    // Decision 14.6: the web's operations alert. Per person, server-side.
    opsAlert: z
      .object({
        sound: z
          .boolean()
          .describe("Tocar som nos alertas da operação (balão flutuante)."),
      })
      .optional(),
  })
  .refine(
    (body) => body.preferences !== undefined || body.opsAlert !== undefined,
    {
      message: "Informe ao menos uma preferência.",
      path: ["preferences"],
    },
  );

export { updateNotificationPreferencesSchema, userFacingCategorySchema };
