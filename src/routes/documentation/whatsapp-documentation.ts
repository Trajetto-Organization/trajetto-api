import { z } from "zod";

import { updateWhatsAppSettingsSchema } from "@/schemas/phone-validation-schema";

const whatsappSettingsData = z.object({
  enabled: z.boolean().describe("Whether WhatsApp notifications are enabled"),
  phoneNumber: z
    .string()
    .optional()
    .describe("Phone number that receives the notifications"),
  serviceConfigured: z
    .boolean()
    .describe(
      "Whether the server has Meta Cloud API credentials — false means saved preferences take effect only after the service is configured",
    ),
});

const whatsappSchemas = {
  updateWhatsAppSettings: updateWhatsAppSettingsSchema,
};

const whatsappResponses = {
  settingsRetrieved: z.object({
    success: z.boolean().default(true),
    message: z.string().default("Configurações obtidas com sucesso"),
    data: whatsappSettingsData,
  }),

  settingsUpdated: z.object({
    success: z.boolean().default(true),
    message: z.string().describe("Update success message"),
    data: whatsappSettingsData,
  }),

  // Error responses
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  settingsErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("O número de telefone é obrigatório para habilitar WhatsApp"),
    }),
    z.object({
      message: z
        .string()
        .default("Este número já está sendo utilizado por outro usuário"),
    }),
  ]),

  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { whatsappSchemas, whatsappResponses };
