import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import {
  CHAT_AUDIO_MAX_DURATION_MS,
  CHAT_MESSAGE_MAX_LENGTH,
} from "@/schemas/send-chat-message-schema";

/**
 * Support tickets (decision 14.5, design §4). Mirrored in the web
 * (actions/chat/tickets) and the app (features/chat).
 */

const SUPPORT_TICKET_KINDS = [
  "OCCURRENCE",
  "DELIVERY",
  "ROUTE",
  "DRIVER",
  "LEGACY",
] as const;

const SUPPORT_TICKET_CLOSE_NOTE_MAX = 500;
const SUPPORT_TICKET_SUBJECT_MIN = 3;
const SUPPORT_TICKET_SUBJECT_MAX = 160;

const uuid = (message: string) => z.string().uuid(message);

const ticketParamsSchema = z.object({
  ticketId: uuid("ID do atendimento é inválido.").describe(
    "O atendimento (ticket).",
  ),
});

const businessIdField = uuid("ID da empresa é inválido.")
  .optional()
  .describe("Só o MASTER envia: escolhe a empresa.");

const listSupportTicketsSchema = z.object({
  businessId: businessIdField,
  status: z
    .enum(["OPEN", "CLOSED", "ALL"], {
      errorMap: () => ({ message: "Status de atendimento inválido." }),
    })
    .default("OPEN")
    .describe("Padrão OPEN."),
  scope: z
    .enum(["ALL", "MINE", "UNASSIGNED", "PENDING_AUTHORIZATION"], {
      errorMap: () => ({ message: "Filtro de atendimento inválido." }),
    })
    .default("ALL")
    .describe(
      "MINE: atribuídos a mim. UNASSIGNED: abertos sem atendente. PENDING_AUTHORIZATION: ocorrência aguardando autorização. Ignorado para o motorista.",
    ),
  kind: z
    .enum(SUPPORT_TICKET_KINDS, {
      errorMap: () => ({ message: "Tipo de atendimento inválido." }),
    })
    .optional()
    .describe(
      "OCCURRENCE, DELIVERY, ROUTE, DRIVER (geral) ou LEGACY (conversa anterior).",
    ),
  driverId: uuid("ID do motorista é inválido.")
    .optional()
    .describe("Só os atendimentos deste motorista."),
  deliveryId: uuid("ID da entrega é inválido.")
    .optional()
    .describe("Só os atendimentos desta entrega."),
  routeId: uuid("ID da rota é inválido.")
    .optional()
    .describe("Só os atendimentos desta rota."),
  occurrenceId: uuid("ID da ocorrência é inválido.")
    .optional()
    .describe("O atendimento desta ocorrência."),
  search: z
    .string()
    .trim()
    .max(100, "A busca pode ter no máximo 100 caracteres.")
    .optional()
    .describe("Assunto, nome do motorista, destinatário ou #número."),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Página, a partir de 1."),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(100, "No máximo 100 atendimentos por página.")
    .default(30)
    .describe("Atendimentos por página, até 100; padrão 30."),
});

const ticketsSummarySchema = z.object({ businessId: businessIdField });

const ticketMessageBodySchema = z
  .object({
    kind: z.enum(["TEXT", "IMAGE", "AUDIO"], {
      errorMap: () => ({ message: "Tipo de mensagem inválido." }),
    }),
    body: z
      .string()
      .trim()
      .max(
        CHAT_MESSAGE_MAX_LENGTH,
        `A mensagem deve ter no máximo ${CHAT_MESSAGE_MAX_LENGTH} caracteres.`,
      )
      .optional(),
    attachmentKey: z.string().max(512).optional(),
    durationMs: z
      .number({ invalid_type_error: "Duração do áudio inválida." })
      .int()
      .positive()
      .max(CHAT_AUDIO_MAX_DURATION_MS, "O áudio pode ter no máximo 2 minutos.")
      .optional(),
    clientSubmissionId: uuid("Identificador de envio inválido.")
      .optional()
      .describe("Âncora de idempotência: o retry nunca duplica a mensagem."),
  })
  .superRefine((message, ctx) => {
    if (message.kind === "TEXT" && !message.body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "Uma mensagem de texto precisa de texto.",
      });
    }

    if (message.kind !== "TEXT" && !message.attachmentKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachmentKey"],
        message: "Mensagens com mídia precisam do anexo enviado antes.",
      });
    }

    if (message.kind === "AUDIO" && !message.durationMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMs"],
        message: "Áudio precisa da duração para o player.",
      });
    }
  });

const openSupportTicketSchema = z.object({
  businessId: businessIdField,
  driverId: uuid("ID do motorista é inválido.")
    .optional()
    .describe(
      "Central: obrigatório, salvo com `deliveryId` (o motorista da entrega). Motorista: omitido (é o dele).",
    ),
  deliveryId: uuid("ID da entrega é inválido.")
    .optional()
    .describe("Atendimento sobre esta entrega (exclusivo com routeId)."),
  routeId: uuid("ID da rota é inválido.")
    .optional()
    .describe("Atendimento sobre esta rota."),
  occurrenceId: uuid("ID da ocorrência é inválido.")
    .optional()
    .describe(
      'Só a central: "Abrir atendimento" de uma ocorrência sem atendimento. Exige a entrega da própria ocorrência.',
    ),
  subject: z
    .string()
    .trim()
    .min(
      SUPPORT_TICKET_SUBJECT_MIN,
      `O assunto deve ter ao menos ${SUPPORT_TICKET_SUBJECT_MIN} caracteres.`,
    )
    .max(
      SUPPORT_TICKET_SUBJECT_MAX,
      `O assunto deve ter no máximo ${SUPPORT_TICKET_SUBJECT_MAX} caracteres.`,
    )
    .optional()
    .describe("Obrigatório para um atendimento geral aberto pela central."),
  message: ticketMessageBodySchema
    .optional()
    .describe("A primeira mensagem, gravada junto com o atendimento."),
});

const closeSupportTicketSchema = z.object({
  ...tenantLockedShape,
  outcome: z.enum(["RESOLVED", "APPROVED", "DENIED"], {
    errorMap: () => ({ message: "Desfecho inválido." }),
  }),
  note: z
    .string()
    .trim()
    .max(
      SUPPORT_TICKET_CLOSE_NOTE_MAX,
      `A observação pode ter no máximo ${SUPPORT_TICKET_CLOSE_NOTE_MAX} caracteres.`,
    )
    .optional()
    .describe("Obrigatória ao negar: é o que o motorista lê."),
});

const assignSupportTicketSchema = z.object({
  ...tenantLockedShape,
  assigneeId: uuid("ID do atendente é inválido.")
    .nullable()
    .describe("Eu = assumir; outro operador = transferir; null = soltar."),
  expectedAssigneeId: uuid("ID do atendente é inválido.")
    .nullable()
    .optional()
    .describe(
      "O atendente que a tela mostrava; se mudou, 409 SUPPORT_TICKET_ASSIGNEE_CHANGED.",
    ),
});

const reopenSupportTicketSchema = z.object({
  ...tenantLockedShape,
  note: z
    .string()
    .trim()
    .max(
      SUPPORT_TICKET_CLOSE_NOTE_MAX,
      `A observação pode ter no máximo ${SUPPORT_TICKET_CLOSE_NOTE_MAX} caracteres.`,
    )
    .optional(),
});

const markTicketReadSchema = z.object({
  ...tenantLockedShape,
  readAt: z
    .string()
    .datetime("readAt deve ser uma data ISO.")
    .optional()
    .describe("Até onde o leitor chegou; sem ele, agora."),
});

const listTicketAssigneesSchema = z.object({
  businessId: businessIdField,
  search: z.string().trim().max(100).optional().describe("Busca por nome."),
});

export {
  SUPPORT_TICKET_KINDS,
  SUPPORT_TICKET_CLOSE_NOTE_MAX,
  SUPPORT_TICKET_SUBJECT_MAX,
  ticketParamsSchema,
  listSupportTicketsSchema,
  ticketsSummarySchema,
  ticketMessageBodySchema,
  openSupportTicketSchema,
  closeSupportTicketSchema,
  assignSupportTicketSchema,
  reopenSupportTicketSchema,
  markTicketReadSchema,
  listTicketAssigneesSchema,
};
