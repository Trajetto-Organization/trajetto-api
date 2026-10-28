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

import { codedRefusal, errorResponse } from "./common-responses";

const isoDateTime = z.union([z.string(), z.date()]);

const signatureStatus = z
  .enum(["SIGNED", "UNSIGNED"])
  .describe(
    "SIGNED: o arquivo guardado tem assinatura digital (decisão 14.8); se ela vale como ICP-Brasil, quem diz é o campo da cadeia (icp_brasil / icpBrasil). UNSIGNED: não tem, e o próprio PDF diz isso.",
  );

const icpBrasilChain = z
  .boolean()
  .nullable()
  .describe(
    "true: a cadeia do certificado foi verificada até uma raiz oficial ICP-Brasil (AC Raiz v5/v10/v11) e o PDF afirma a validade jurídica da MP 2.200-2. false: assinado com certificado fora dessa cadeia, sem essa afirmação. null: sem assinatura, ou assinado antes da verificação da cadeia (só o nome do emissor era lido).",
  );

const signatureProfile = z
  .enum(["PADES_AD_RB", "CMS_DETACHED"])
  .nullable()
  .describe(
    "PAdES ICP-Brasil AD-RB v1.1 ou CMS destacado simples; null sem assinatura.",
  );

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

      layout_version: z
        .number()
        .describe(
          "1 = layout anterior à decisão 14.8; 2 = o modelo validado. Um documento antigo não é refeito sozinho: use `regenerate=true`.",
        ),

      signature: z.object({
        status: signatureStatus,
        profile: signatureProfile,
        signer_name: z
          .string()
          .nullable()
          .describe(
            "Razão social do certificado (CN antes de ':'), nunca de configuração.",
          ),
        signer_cnpj: z
          .string()
          .nullable()
          .describe("CNPJ do certificado (CN depois de ':'), 14 dígitos."),
        cert_not_after: isoDateTime.nullable(),
        signed_at: isoDateTime.nullable(),
        icp_brasil: icpBrasilChain,
        unsigned_reason: z
          .enum([
            "LEGACY",
            "NO_CERTIFICATE",
            "CERTIFICATE_EXPIRED",
            "CERTIFICATE_INVALID",
            "SIGNING_DISABLED",
          ])
          .nullable()
          .describe(
            "Por que não foi assinado. LEGACY: gerado antes da assinatura existir. Null quando assinado.",
          ),
      }),

      signing_available: z
        .boolean()
        .describe(
          "Se o servidor assinaria um documento gerado AGORA (certificado válido configurado). Com `signature.status = UNSIGNED`, indica que gerar de novo produz a versão assinada.",
        ),
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
        timeZone: z
          .string()
          .describe(
            "Fuso da transportadora (IANA), o mesmo em que o PDF imprime os horários: a página mostra deliveredAt e generatedAt nele.",
          ),
        signature: z
          .object({
            status: signatureStatus,
            profile: signatureProfile,
            signerName: z.string().nullable(),
            certNotAfter: isoDateTime.nullable(),
            signedAt: isoDateTime.nullable(),
            icpBrasil: icpBrasilChain,
          })
          .describe(
            "O que registramos sobre a assinatura do arquivo. Não afirma validade jurídica: quem a confere é o validar.iti.gov.br, com o PDF.",
          ),
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
      timeZone: z
        .string()
        .describe(
          "Fuso da transportadora (IANA): os instantes são exibidos nele. A previsão é um dia (AAAA-MM-DD na meia-noite UTC), sem hora.",
        ),

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
        topic: z.enum(["DISPATCHED", "ON_THE_WAY", "DELIVERED", "FAILED"]),
        channel: z.string(),
        subject: z.string().nullable(),
        body: z.string(),
        is_active: z.boolean(),
        businessId: z.string(),
      }),
    ),
  }),

  genericError: z.object({ message: z.string() }),

  /**
   * What GET /delivery/proof-document really answers on a refusal (decision
   * 11.3): the shared shape with its codes. `genericError` stays for the
   * message-template routes that still send `{ message }`.
   */
  proofDocumentError: errorResponse.describe(
    "Recusa com `code` estável. 400: VALIDATION_ERROR; 403: PERMISSION_DENIED (inclui `regenerate=true` sem escrita em `delivery_manage`), MODULE_NOT_ENABLED, TENANT_ACCESS_DENIED, TENANT_INACTIVE (`regenerate=true` numa empresa desativada); 404: DELIVERY_NOT_FOUND (inexistente, de outra empresa ou, para o motorista, de outro motorista), USER_NOT_FOUND (o usuário da sessão deixou de existir); 409: DELIVERY_NOT_SETTLED (a entrega ainda não terminou); 503: PROOF_RENDER_BUSY, PROOF_RENDER_TIMEOUT, PROOF_RENDER_UNAVAILABLE, PROOF_SIGNING_FAILED (a assinatura falhou com o certificado válido; nada foi gravado, tente de novo), STORAGE_UNAVAILABLE (o armazenamento não respondeu ao ler a foto ou a assinatura, ou ao gravar o PDF; nada foi gravado, tente de novo).",
  ),

  /**
   * GET /public/verify-proof: storage that did not answer is a 503 to retry,
   * never `intact: false` (UploadService.readObject); the database being
   * down is the error handler's 503.
   */
  verifyProofUnavailable: codedRefusal(
    "Não foi possível conferir agora. STORAGE_UNAVAILABLE: o armazenamento não respondeu ao ler o arquivo — o documento pode estar íntegro, e isso nunca é respondido como `intact: false`. SERVICE_UNAVAILABLE: o banco de dados está indisponível por instantes. Transitório: espere o `retry-after` e repita.",
    ["STORAGE_UNAVAILABLE", "SERVICE_UNAVAILABLE"],
  ),

  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { proofDocumentSchemas, proofDocumentResponses };
