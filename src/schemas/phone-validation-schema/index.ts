import { z } from "zod";

const updateWhatsAppSettingsSchema = z
  .object({
    whatsapp_notifications_enabled: z.boolean({
      required_error: "Estado de notificação WhatsApp é obrigatório",
    }),
    whatsapp_phone: z
      .string()
      .optional()
      .refine(
        (phone) => {
          // If no phone provided, it's valid (for disable scenarios)
          if (!phone) return true;

          // Remove all non-digits
          const cleaned = phone.replace(/\D/g, "");

          // Brazilian phone: 10 digits (landline) or 11 digits (mobile)
          return cleaned.length === 10 || cleaned.length === 11;
        },
        {
          message: "Número de telefone deve conter 10 ou 11 dígitos",
        },
      )
      .transform((phone) => {
        // If no phone, return undefined
        if (!phone) return undefined;

        // Clean and return only digits
        return phone.replace(/\D/g, "");
      }),
  })
  .refine(
    (data) => {
      // Only require phone when ENABLING notifications
      if (data.whatsapp_notifications_enabled && !data.whatsapp_phone) {
        return false;
      }

      return true;
    },
    {
      message:
        "Número de telefone é obrigatório para habilitar as notificações WhatsApp",
      path: ["whatsapp_phone"],
    },
  );

// Additional schema for phone-only updates
const phoneUpdateSchema = z.object({
  phone: z
    .string()
    .min(1, "Número de telefone é obrigatório")
    .refine(
      (phone) => {
        const cleaned = phone.replace(/\D/g, "");
        return cleaned.length === 10 || cleaned.length === 11;
      },
      {
        message: "Número de telefone deve conter 10 ou 11 dígitos",
      },
    )
    .transform((phone) => phone.replace(/\D/g, "")),
});

// Schema for formatting phone numbers
const formatPhoneSchema = z.object({
  phone: z.string().transform((phone) => {
    const cleaned = phone.replace(/\D/g, "");

    if (cleaned.length === 10) {
      // Landline: (XX) XXXX-XXXX
      return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 6)}-${cleaned.slice(6)}`;
    } else if (cleaned.length === 11) {
      // Mobile: (XX) 9XXXX-XXXX
      return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 7)}-${cleaned.slice(7)}`;
    }

    return phone; // Return as-is if invalid
  }),
});

export { updateWhatsAppSettingsSchema, phoneUpdateSchema, formatPhoneSchema };
