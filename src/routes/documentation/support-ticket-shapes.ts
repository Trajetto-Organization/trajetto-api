import { z } from "zod";

/**
 * The support ticket wire shapes (decision 14.5), shared by the chat and the
 * ticket documentation without importing each other.
 */
const isoDateTime = z.union([z.string(), z.date()]);
const person = z.object({ id: z.string(), name: z.string() });

const ticketKind = z.enum([
  "OCCURRENCE",
  "DELIVERY",
  "ROUTE",
  "DRIVER",
  "LEGACY",
]);
const ticketOutcome = z.enum(["RESOLVED", "APPROVED", "DENIED", "MIGRATED"]);
const authorizationStatus = z.enum([
  "NOT_REQUIRED",
  "PENDING",
  "APPROVED",
  "DENIED",
  "SUPERSEDED",
]);

/** TicketSummary (design §4.1), held to the presenter by the contract test. */
const ticketSummary = z.object({
  id: z.string(),
  number: z.number().int().describe("Sequencial por empresa (#128)."),
  kind: ticketKind,
  status: z.enum(["OPEN", "CLOSED"]),
  subject: z.string(),
  version: z
    .number()
    .int()
    .describe("Sobe a cada mudança; o cliente descarta evento mais velho."),
  threadId: z.string(),
  driver: person,
  delivery: z
    .object({ id: z.string(), recipient_name: z.string(), status: z.string() })
    .nullable(),
  route: z
    .object({
      id: z.string(),
      code: z.number().int(),
      name: z.string().nullable(),
    })
    .nullable(),
  occurrence: z
    .object({
      id: z.string(),
      typeName: z.string(),
      authorization_status: authorizationStatus,
      escalates_at: z
        .string()
        .nullable()
        .describe("Só com autorização pendente."),
    })
    .nullable(),
  assignee: person.nullable().describe("Quem atende; null = sem atendente."),
  waitingOn: z
    .enum(["STAFF", "DRIVER"])
    .nullable()
    .describe("Derivado do lado da última mensagem."),
  opened_via: z.enum([
    "OCCURRENCE_REPORT",
    "DRIVER_APP",
    "PANEL",
    "LEGACY_ROUTING",
    "MIGRATION",
  ]),
  openedBy: person.nullable(),
  closedBy: person.nullable().describe("Quem encerrou."),
  closed_at: z.string().nullable(),
  close_outcome: ticketOutcome.nullable(),
  close_note: z.string().nullable(),
  closeOutcomes: z
    .array(z.enum(["RESOLVED", "APPROVED", "DENIED"]))
    .describe(
      'O que "Encerrar" oferece: APPROVED/DENIED com autorização pendente, RESOLVED nos demais, vazio fechado.',
    ),
  last_message_at: z.string().nullable(),
  lastMessage: z
    .object({
      kind: z.enum(["TEXT", "IMAGE", "AUDIO"]),
      preview: z.string().nullable(),
      sender: person,
    })
    .nullable(),
  unreadCount: z.number().int().describe("Não lidas de quem pede (até 100)."),
  created_at: z.string(),
});

/** What the driver hears about a ticket: never who handles it inside the company. */
const driverTicketViewShape = ticketSummary
  .pick({
    id: true,
    number: true,
    kind: true,
    status: true,
    subject: true,
    version: true,
    delivery: true,
    route: true,
    closed_at: true,
    close_outcome: true,
    close_note: true,
    created_at: true,
  })
  .extend({
    occurrence: z
      .object({
        id: z.string(),
        typeName: z.string(),
        authorization_status: authorizationStatus,
      })
      .nullable(),
  });

export {
  isoDateTime,
  person,
  ticketKind,
  ticketOutcome,
  authorizationStatus,
  ticketSummary,
  driverTicketViewShape,
};
