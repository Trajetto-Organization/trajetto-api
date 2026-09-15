import { z } from "zod";

import {
  listDeliveryMessageTemplateSchema,
  saveDeliveryMessageTemplateSchema,
} from "@/schemas/delivery-message-template-schema";

import {
  proofDocumentParamsSchema,
  proofDocumentQuerySchema,
  publicTokenParamsSchema,
  verifyProofParamsSchema,
} from "@/schemas/proof-document-schema";

const isoDateTime = z.union([z.string(), z.date()]);

const proofDocumentSchemas = {
  proofDocumentParams: proofDocumentParamsSchema,
  proofDocumentQuery: proofDocumentQuerySchema,
  verifyProofParams: verifyProofParamsSchema,
  publicTokenParams: publicTokenParamsSchema,

  saveMessageTemplate: saveDeliveryMessageTemplateSchema,
  listMessageTemplates: listDeliveryMessageTemplateSchema,
};

const proofDocumentResponses = {
  proofDocument: z.object({
    message: z.string(),
    data: z.object({
      url: z
        .string()
        .describe("Link curto para o PDF. Expira — não guarde, peça de novo."),
      filename: z.string(),

      verificationUrl: z
        .string()
        .describe("A página pública que o QR do documento aponta."),

      sha256: z
        .string()
        .describe(
          "Do arquivo exato que foi gravado. A página pública recalcula e compara.",
        ),

      version: z
        .number()
        .describe(
          "Sobe a cada regeração. O token continua o mesmo, então um QR impresso antes ainda chega à página — a versão é o que diz que aquela cópia não é a atual.",
        ),

      generated_at: isoDateTime,
      size_bytes: z.number(),
    }),
  }),

  proofVerification: z.object({
    message: z.string(),
    data: z.object({
      intact: z
        .boolean()
        .describe(
          "Se os bytes que estão no bucket AGORA ainda batem com o hash gravado quando o documento foi feito. É por isto que alguém escaneou o código.",
        ),

      storedSha256: z
        .string()
        .nullable()
        .describe(
          "Null quando o arquivo sumiu do armazenamento — que NÃO é a mesma coisa que adulterado.",
        ),

      summary: z.object({
        recipientName: z.string(),
        city: z.string(),
        uf: z.string(),
        invoiceNumber: z.string().nullable(),
        carrierName: z.string(),
        deliveredAt: isoDateTime.nullable(),
        receivedBy: z.string().nullable(),
        sha256: z.string(),
        generatedAt: isoDateTime,
        version: z.number(),
      }),

      url: z.string().nullable(),
    }),
  }),

  tracking: z.object({
    message: z.string(),
    data: z.object({
      recipientName: z.string(),
      city: z.string(),
      uf: z.string(),

      status: z.string(),
      statusLabel: z.string(),

      invoiceNumber: z.string().nullable(),
      code: z.string().nullable(),

      scheduledDate: isoDateTime.nullable(),
      deliveredAt: isoDateTime.nullable(),
      receivedBy: z.string().nullable(),

      carrierName: z.string(),

      events: z.array(
        z.object({
          at: isoDateTime,
          title: z.string(),
          detail: z.string().nullable(),
        }),
      ),

      proofUrl: z
        .string()
        .nullable()
        .describe(
          "A página pública de verificação, não o arquivo. Uma porta só, uma história só sobre o documento ser legítimo.",
        ),
    }),
  }),

  optedOut: z.object({ message: z.string() }),

  messageTemplateSaved: z.object({
    message: z.string().default("Mensagem salva com sucesso!"),
    data: z.object({ id: z.string() }),
  }),

  messageTemplateList: z.object({
    message: z.string(),
    total: z.number(),
    data: z.array(
      z.object({
        id: z.string(),
        topic: z.enum(["DISPATCHED", "DELIVERED", "FAILED"]),
        channel: z.string(),
        subject: z.string().nullable(),
        body: z.string(),
        is_active: z.boolean(),
        businessId: z.string(),
      }),
    ),
  }),

  genericError: z.object({ message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { proofDocumentSchemas, proofDocumentResponses };
