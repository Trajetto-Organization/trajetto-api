import { z } from "zod";

import {
  assignSupportTicketSchema,
  closeSupportTicketSchema,
  listSupportTicketsSchema,
  listTicketAssigneesSchema,
  markTicketReadSchema,
  openSupportTicketSchema,
  reopenSupportTicketSchema,
  ticketMessageBodySchema,
  ticketParamsSchema,
  ticketsSummarySchema,
} from "@/schemas/support-ticket-schema";

import { documentedAs } from "./doc-only-responses";
import { errorResponse } from "./common-responses";
import { chatDocumented } from "./chat-documentation";

import {
  authorizationStatus,
  isoDateTime,
  person,
  ticketOutcome,
  ticketSummary,
} from "./support-ticket-shapes";

const ticketCounts = z.object({
  open: z.number().int(),
  unassigned: z.number().int(),
  mine: z.number().int(),
  pendingAuthorization: z.number().int(),
  unreadOpen: z
    .number()
    .int()
    .describe("Atendimentos abertos com mensagem não lida por quem pede."),
});

const ticketPermissions = z.object({
  canWrite: z.boolean(),
  canAssign: z.boolean(),
  canClose: z.boolean(),
  canReopen: z.boolean(),
  canDecide: z.boolean(),
  closeOutcomes: z.array(z.enum(["RESOLVED", "APPROVED", "DENIED"])),
});

const occurrenceDetail = z
  .object({
    id: z.string(),
    typeName: z.string(),
    description: z.string().nullable(),
    photos: z.array(z.string()).describe("URLs assinadas na leitura."),
    receipt_photo_url: z.string().nullable(),
    answers: z.array(z.object({ label: z.string(), value: z.string() })),
    reportedBy: person,
    occurred_at: isoDateTime.nullable(),
    created_at: isoDateTime,
    authorization_status: authorizationStatus,
    authorizedBy: person.nullable(),
    authorized_at: isoDateTime.nullable(),
    authorization_note: z.string().nullable(),
    escalated_at: isoDateTime.nullable(),
    blocks_delivery: z.boolean(),
  })
  .nullable();

const ticketEvent = z.object({
  id: z.string(),
  ticketId: z.string(),
  businessId: z.string(),
  type: z.enum([
    "OPENED",
    "ASSIGNED",
    "UNASSIGNED",
    "CLOSED",
    "REOPENED",
    "OCCURRENCE_LINKED",
    "AUTHORIZATION_DECIDED",
    "AUTHORIZATION_SUPERSEDED",
  ]),
  actor_kind: z.enum(["USER", "DRIVER_APP", "SYSTEM"]),
  actorId: z.string().nullable(),
  actor_name: z.string().nullable().describe("Nome no momento do evento."),
  target_user_id: z.string().nullable(),
  target_user_name: z.string().nullable(),
  outcome: ticketOutcome.nullable(),
  note: z.string().nullable(),
  created_at: isoDateTime,
});

const sentMessage = chatDocumented.message.extend({
  driver: person,
  senderSide: z.enum(["DRIVER", "STAFF"]),
  ticketId: z.string().nullable(),
  ticket: z
    .object({
      id: z.string(),
      number: z.number().int(),
      status: z.enum(["OPEN", "CLOSED"]),
      assigneeId: z.string().nullable(),
      version: z.number().int(),
    })
    .nullable(),
});

const supportTicketDocumented = {
  summary: ticketSummary,
  counts: ticketCounts,
  event: ticketEvent,
  permissions: ticketPermissions,
  occurrenceDetail,
};

/** 409s and 404s that carry who closed / who holds the ticket. */
const ticketConflict = documentedAs(
  errorResponse.passthrough(),
  errorResponse.extend({
    closedBy: person.nullable().optional(),
    closed_at: z.string().nullable().optional(),
    outcome: z.string().nullable().optional(),
    assignee: person.nullable().optional(),
    ticketId: z.string().optional(),
    number: z.number().int().optional(),
    decision: z
      .unknown()
      .optional()
      .describe("OCCURRENCE_ALREADY_DECIDED: a decisão que vale."),
  }),
);

const supportTicketSchemas = {
  params: ticketParamsSchema,
  list: listSupportTicketsSchema,
  summary: ticketsSummarySchema,
  open: openSupportTicketSchema,
  close: closeSupportTicketSchema,
  assign: assignSupportTicketSchema,
  reopen: reopenSupportTicketSchema,
  markRead: markTicketReadSchema,
  messageBody: ticketMessageBodySchema,
  assignees: listTicketAssigneesSchema,
  masterQuery: z.object({
    businessId: z
      .string()
      .uuid("ID da empresa é inválido.")
      .optional()
      .describe("Só o MASTER."),
  }),
};

const supportTicketResponses = {
  list: documentedAs(
    z.object({
      data: z.array(z.unknown()),
      total: z.number(),
      counts: z.unknown(),
    }),
    z.object({
      data: z.array(ticketSummary),
      total: z.number().int(),
      counts: ticketCounts,
    }),
  ),
  summary: documentedAs(z.object({}).passthrough(), ticketCounts),
  detail: documentedAs(
    z.object({ data: z.unknown() }),
    z.object({
      data: ticketSummary.extend({
        occurrenceDetail,
        permissions: ticketPermissions,
      }),
    }),
  ),
  opened: documentedAs(
    z.object({ data: z.unknown(), created: z.boolean(), message: z.unknown() }),
    z.object({
      message: sentMessage
        .nullable()
        .describe("A primeira mensagem, quando enviada."),
      data: ticketSummary,
      created: z
        .boolean()
        .describe(
          "false: já havia atendimento aberto da entrega/rota, ou replay da mesma Idempotency-Key.",
        ),
    }),
  ),
  closed: documentedAs(
    z
      .object({ message: z.string(), data: z.unknown(), replayed: z.boolean() })
      .passthrough(),
    z.object({
      message: z.string(),
      data: ticketSummary,
      decision: z
        .object({
          id: z.string(),
          deliveryId: z.string(),
          authorization_status: z.enum(["APPROVED", "DENIED"]),
          authorized_at: isoDateTime,
          authorizedBy: person,
          authorization_note: z.string().nullable(),
          deliveryStatus: z.string(),
          replayed: z.boolean(),
        })
        .optional()
        .describe(
          "A decisão da ocorrência, quando encerrar foi autorizar ou negar.",
        ),
      replayed: z.boolean(),
    }),
  ),
  ticket: documentedAs(
    z.object({ message: z.string(), data: z.unknown(), replayed: z.boolean() }),
    z.object({
      message: z.string(),
      data: ticketSummary,
      replayed: z.boolean(),
    }),
  ),
  events: documentedAs(
    z.object({ data: z.array(z.unknown()) }),
    z.object({ data: z.array(ticketEvent) }),
  ),
  messageSent: documentedAs(
    z.object({ message: z.string(), data: z.unknown() }),
    z.object({ message: z.string(), data: sentMessage }),
  ),
  markRead: documentedAs(
    z.object({
      message: z.string(),
      data: z.object({ last_read_at: z.unknown() }),
    }),
    z.object({
      message: z.string(),
      data: z.object({ last_read_at: isoDateTime }),
    }),
  ),
  assignees: z.object({ data: z.array(person) }),
  conflict: ticketConflict,
  error: errorResponse,
};

export {
  supportTicketSchemas,
  supportTicketResponses,
  supportTicketDocumented,
};
