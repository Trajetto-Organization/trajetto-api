import { z } from "zod";

import { updateWhatsAppSettingsSchema } from "@/schemas/phone-validation-schema";

const whatsappSchemas = {
  updateWhatsAppSettings: updateWhatsAppSettingsSchema,
  webhookInstanceParam: z.object({
    instanceName: z.string().min(1, "Instance name is required"),
  }),
};

const whatsappResponses = {
  settingsRetrieved: z.object({
    success: z.boolean().default(true),
    message: z.string().default("Configurações obtidas com sucesso"),
    data: z.object({
      enabled: z
        .boolean()
        .describe("Whether WhatsApp notifications are enabled"),
      phoneNumber: z
        .string()
        .optional()
        .describe("Configured WhatsApp phone number"),
      instanceConnected: z.boolean().describe("Whether instance is connected"),
      instanceName: z.string().describe("WhatsApp instance name"),
    }),
  }),

  settingsUpdated: z.object({
    success: z.boolean().default(true),
    message: z.string().describe("Update success message"),
    data: z.object({
      enabled: z
        .boolean()
        .describe("Whether WhatsApp notifications are enabled"),
      phoneNumber: z
        .string()
        .optional()
        .describe("Configured WhatsApp phone number"),
      instanceConnected: z.boolean().describe("Whether instance is connected"),
      instanceName: z.string().describe("WhatsApp instance name"),
    }),
  }),

  statusRetrieved: z.object({
    success: z.boolean().default(true),
    message: z.string().default("Status atualizado com sucesso"),
    data: z.object({
      instanceName: z.string().describe("WhatsApp instance name"),
      status: z
        .enum(["connected", "disconnected", "connecting", "not_exists"])
        .describe("Connection status"),
      phoneNumber: z.string().optional().describe("Connected phone number"),
      qrCodeAvailable: z.boolean().describe("Whether QR code is available"),
      pairingCodeAvailable: z
        .boolean()
        .describe("Whether pairing code is available"),
    }),
  }),

  qrCodeGenerated: z.object({
    success: z.boolean().default(true),
    message: z.string().default("QR Code gerado com sucesso"),
    data: z.object({
      code: z.string().describe("Base64 encoded QR code"),
      expiresIn: z
        .number()
        .optional()
        .describe("QR code expiration time in seconds"),
    }),
  }),

  webhookReceived: z.object({
    success: z.boolean().default(true),
    message: z.string().default("Webhook processed successfully"),
  }),

  // Error responses
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  whatsappNumberRequired: z.object({
    message: z
      .string()
      .default(
        "Número de telefone é obrigatório para habilitar as notificações WhatsApp",
      ),
  }),

  whatsappPhoneUpdateNotAllowed: z.object({
    message: z
      .string()
      .default(
        "Não é possível alterar o número do WhatsApp enquanto a instância estiver conectada",
      ),
  }),

  whatsappPhoneAlreadyInUse: z.object({
    message: z
      .string()
      .default(
        "Este número de WhatsApp já está sendo utilizado por outro usuário",
      ),
  }),

  whatsappNotConnected: z.object({
    message: z
      .string()
      .default("WhatsApp não está conectado. Configure e conecte primeiro"),
  }),

  whatsappNumberNotConfigured: z.object({
    message: z
      .string()
      .default(
        "Número do WhatsApp não configurado. Configure um número primeiro",
      ),
  }),

  whatsappAlreadyConnected: z.object({
    message: z.string().default("WhatsApp já está conectado para este usuário"),
  }),

  businessAdminOnly: z.object({
    message: z
      .string()
      .default(
        "Apenas administradores de empresa podem gerenciar configurações WhatsApp",
      ),
  }),

  validationError: z.object({
    message: z.string().default("Erro de validação"),
    issues: z
      .array(z.string())
      .optional()
      .describe("List of validation errors"),
  }),

  internalServerError: z.object({
    message: z.string().default("Erro interno do servidor"),
  }),

  // Grouped error responses
  settingsErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Número de telefone é obrigatório para habilitar as notificações WhatsApp",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível alterar o número do WhatsApp enquanto a instância estiver conectada",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este número de WhatsApp já está sendo utilizado por outro usuário",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Apenas administradores de empresa podem gerenciar configurações WhatsApp",
        ),
    }),
  ]),

  statusErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("WhatsApp não está conectado. Configure e conecte primeiro"),
    }),
  ]),

  qrCodeErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("WhatsApp não está conectado. Configure e conecte primeiro"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Número do WhatsApp não configurado. Configure um número primeiro",
        ),
    }),
    z.object({
      message: z
        .string()
        .default("WhatsApp já está conectado para este usuário"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este número de WhatsApp já está sendo utilizado por outro usuário",
        ),
    }),
  ]),
};

export { whatsappSchemas, whatsappResponses };
