import { z } from "zod";

import { updateWhatsAppSettingsSchema } from "@/schemas/phone-validation-schema";

import { errorResponse } from "./common-responses";

const whatsappSettingsData = z.object({
  enabled: z.boolean().describe("Se os avisos por WhatsApp estão ligados"),
  phoneNumber: z.string().optional().describe("Telefone que recebe os avisos"),
  serviceConfigured: z
    .boolean()
    .describe(
      "Se o servidor tem as credenciais da Meta Cloud API — false quer dizer que a preferência salva só vale depois que o serviço for configurado",
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
    message: z.string().describe("Mensagem de sucesso"),
    data: whatsappSettingsData,
  }),

  // Every refusal carries `code` (decision 11.3); the session user who no
  // longer exists is 404 USER_NOT_FOUND.
  sessionUserNotFound: errorResponse.describe(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  settingsErrors: errorResponse.describe(
    "VALIDATION_ERROR (corpo recusado; issues diz qual) ou WHATSAPP_NUMBER_REQUIRED (ligar os avisos sem informar o telefone).",
  ),

  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { whatsappSchemas, whatsappResponses };
