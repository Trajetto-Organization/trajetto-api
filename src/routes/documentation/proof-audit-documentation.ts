import { z } from "zod";
import { responseDateTime } from "./response-date";

import {
  listProofAuditsSchema,
  reviewProofAuditParamsSchema,
  reviewProofAuditSchema,
} from "@/schemas/proof-audit-schema";

import { errorResponse } from "./common-responses";
import { devicePrecheckSchema } from "@/shared/ai-precheck/device-precheck";

const proofAuditSchemas = {
  listProofAudits: listProofAuditsSchema,
  reviewProofAuditParams: reviewProofAuditParamsSchema,
  reviewProofAudit: reviewProofAuditSchema,
};

const proofAuditResponses = {
  /**
   * NOT a JSON object: this endpoint streams `application/x-ndjson` like every
   * other offset listing in the API — an envelope line, then one card per line.
   */
  auditQueueEnvelope: z.object({
    meta: z.object({
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),

      searchMeta: z.object({
        pending: z.number(),
        approved: z.number(),
        rejected: z.number(),

        agreementRate: z
          .number()
          .nullable()
          .describe(
            "Com que frequência a máquina e a pessoa disseram a mesma coisa, sobre os cards revisados que TÊM sugestão e foram decididos nos últimos `agreementWindowDays` dias (corridos, hoje incluído, contados a partir da meia-noite no fuso da empresa). Null quando nada foi revisado na janela. É o único número que responde se a IA vale o que custa.",
          ),
        agreementWindowDays: z
          .number()
          .int()
          .describe(
            "Janela da taxa de concordância, em dias corridos (hoje incluído), contada no fuso da empresa.",
          ),
        timeZone: z
          .string()
          .optional()
          .describe(
            "O fuso da empresa (IANA), ex.: America/Sao_Paulo: a aba da torre mostra os horários nele, com a nota, como o detalhe da rota (plano de 02/11/2026, H6; decisão D22). Sem ele (versão anterior da API), o navegador.",
          ),
      }),
    }),
  }),

  /** One card of the queue, after the envelope line (ProofAuditCard). */
  auditQueueCard: z.object({
    id: z.string(),
    deliveryId: z.string(),
    businessId: z.string(),
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
    ai_suggestion: z
      .object({
        reading: z
          .record(z.string(), z.unknown())
          .describe(
            "A leitura da foto. Cada critério vale `yes`, `no`, `unknown` ou `not_applicable` (entrega sem número de NF-e para conferir): `isReceipt` (é um canhoto de entrega; ausente em leituras anteriores à decisão 6.9), `legible`, `hasSignature`, `dateVisible` e `documentMatches`. Traz também `photoQuality` e `confidence` (0 a 1) e `observation` (uma frase em português). Leituras novas trazem `extracted` (o que a IA transcreveu: `documentNumber`, `receiptDateText`, `receiptDate`, `recipientName`, `signatureOnPaper` e `digitalSignature`) e `expected` (o que a entrega esperava: `documentNumber`, `provenOn` e `recipientName`). Campos desconhecidos são preservados.",
          ),
        assessment: z.record(z.string(), z.unknown()),
      })
      .nullable()
      .describe("O que a IA leu no canhoto e o que sugeriu; null sem análise."),
    ai_confidence: z.number().nullable(),
    ai_analyzed_at: responseDateTime().nullable(),
    reviewedById: z.string().nullable(),
    reviewed_at: responseDateTime().nullable(),
    rejection_reason: z.string().nullable(),
    created_at: responseDateTime(),
    delivery: z.object({
      id: z.string(),
      recipient_name: z.string(),
      city: z.string(),
      uf: z.string(),
      invoice_number: z.string().nullable(),
      code: z.string().nullable(),
      delivered_at: responseDateTime().nullable(),
      received_by: z.string().nullable(),
      driverName: z.string().nullable(),
    }),
    photoUrl: z
      .string()
      .nullable()
      .describe("URL assinada de vida curta, não um caminho de storage."),
    signatureUrl: z.string().nullable(),
    reviewerName: z.string().nullable(),
    analysisStatus: z
      .enum([
        "PENDING",
        "PROCESSING",
        "COMPLETED",
        "PARTIAL",
        "FAILED",
        "SKIPPED",
      ])
      .nullable()
      .describe(
        "Situação do último pedido de leitura automática desta entrega; null quando nenhum foi aberto.",
      ),
    aiState: z
      .enum([
        "read",
        "device_provisional",
        "analyzing",
        "failed",
        "quota_exceeded",
        "not_contracted",
        "unavailable",
      ])
      .describe(
        "O que o card diz sobre a leitura automática: lida, pré-checagem do celular provisória (há `device_precheck` e a leitura do servidor está em andamento), em andamento, falhou, limite do período atingido, não contratada pela empresa, ou indisponível.",
      ),
    device_precheck: devicePrecheckSchema
      .nullable()
      .describe(
        "Pré-checagem feita offline no celular do motorista (decisão 14.2), como o aparelho declarou: NF encontrada na foto, data legível fora do dia da entrega, resultado e se o motorista enviou mesmo depois de um aviso. Null quando não houve, ou a empresa não contrata a leitura.",
      ),
    device_agreement: z
      .enum(["AGREE", "DISAGREE", "NOT_APPLICABLE"])
      .nullable()
      .describe(
        "Veredito gravado pelo servidor sobre a pré-checagem; null enquanto não gravado.",
      ),
    deviceAgreement: z
      .enum(["AGREE", "DISAGREE", "NOT_APPLICABLE"])
      .nullable()
      .describe(
        "A pré-checagem do celular contra a leitura do servidor (NF encontrada × NF lida igual à esperada): concorda, discorda, ou não se aplica (um dos lados não pôde dizer). Null sem pré-checagem ou sem leitura do servidor.",
      ),
  }),

  auditReviewed: z.object({ message: z.string() }),

  /**
   * The body a refusal really carries (decision 11.3): the shared shape, with
   * the codes these two routes answer, so a client can tell them apart.
   */
  genericError: errorResponse.describe(
    "Recusa com `code` estável. Listagem — 400: VALIDATION_ERROR (inclusive página ou tamanho de página que não seja inteiro), BUSINESS_NOT_IDENTIFIED; 403: PERMISSION_DENIED (inclusive o motorista), MODULE_NOT_ENABLED, TENANT_ACCESS_DENIED; 404: USER_NOT_FOUND (o usuário da sessão deixou de existir). Revisão — 400: VALIDATION_ERROR, REJECTION_REASON_REQUIRED, INVALID_REJECTION_REASON (motivo fora das regras de texto: 5 a 500 caracteres depois de tirar os espaços das pontas, sem espaços consecutivos na mesma linha); 403: PERMISSION_DENIED (inclusive o motorista), MODULE_NOT_ENABLED, TENANT_INACTIVE, TENANT_ACCESS_DENIED; 404: PROOF_AUDIT_NOT_FOUND (inexistente ou de outra empresa), USER_NOT_FOUND; 409: PROOF_AUDIT_ALREADY_REVIEWED (inclusive quando o card já estava decidido ao chegar o pedido).",
  ),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { proofAuditSchemas, proofAuditResponses };
