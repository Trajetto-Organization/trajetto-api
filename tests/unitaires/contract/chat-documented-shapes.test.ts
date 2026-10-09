import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ChatMessageView, ChatThreadListEntry } from "@/modules/chat/dtos/chat-dto";
import { presentChatMessage } from "@/modules/chat/usecases/shared/chat-presenter";

import type { ListChatMessagesUseCase } from "@/modules/chat/usecases/list-chat-messages/list-chat-messages-usecase";
import type { SearchChatMessagesUseCase } from "@/modules/chat/usecases/search-chat-messages/search-chat-messages-usecase";
import type { SendChatMessageResponse } from "@/modules/chat/usecases/send-chat-message/send-chat-message-usecase";
import type { ListChatRecipientsResponse } from "@/modules/chat/usecases/list-chat-recipients/list-chat-recipients-usecase";

import type { UploadService } from "@/shared/services/upload-service";

import { chatDocumented, chatResponses } from "@/routes/documentation/chat-documentation";
import { documentedDocFor } from "@/routes/documentation/doc-only-responses";

import { strictIssues } from "./support/deep-strict";

import type { SupportTicketRow } from "@/modules/chat/dtos/support-ticket-dto";
import {
  driverTicketView,
  presentTicket,
} from "@/modules/chat/usecases/shared/ticket-presenter";
import {
  supportTicketDocumented,
  supportTicketResponses,
} from "@/routes/documentation/support-ticket-documentation";

/**
 * The chat's documented shapes, held to the DTOs the use cases return.
 *
 * The chat's runtime schemas pass the rows through on purpose, so nothing at
 * runtime notices when the document drifts from what really goes out. These
 * literals are typed with the DTOs: a field added to a DTO fails the
 * typecheck here until it is added below, and then fails the strict parse
 * until the document lists it — the drift the pass-through would hide.
 */
const signer = {
  getFileUrl: async (key: string) => `https://storage.exemplo/${key}?assinada`,
} as unknown as UploadService;

const view: ChatMessageView = {
  id: "m1",
  kind: "IMAGE",
  body: "Chegando",
  attachment_key: "chat/foto.jpg",
  duration_ms: null,
  deliveryId: "d1",
  routeId: "r1",
  broadcast_id: null,
  client_submission_id: "0192f7f0-0000-7000-8000-000000000001",
  threadId: "t1",
  ticketId: "tk1",
  senderId: "u1",
  created_at: new Date("2026-09-24T10:00:00Z"),
  sender: { id: "u1", name: "Motorista" },
  delivery: { id: "d1", recipient_name: "Cliente", status: "IN_TRANSIT" },
  route: { id: "r1", code: 12, name: "Zona Leste" },
};

const threadEntry: ChatThreadListEntry = {
  id: "t1",
  driver: { id: "dr1", name: "Motorista", cnh: "123" },
  driverUser: { id: "u1", last_seen_at: new Date("2026-09-24T09:00:00Z") },
  lastMessage: {
    kind: "TEXT",
    body: "Oi",
    sender: { id: "u1", name: "Motorista" },
    created_at: new Date("2026-09-24T10:00:00Z"),
  },
  unreadCount: 2,
};

/** A ticket row with everything resolved, as the repository returns it. */
const ticketRow: SupportTicketRow = {
  id: "tk1",
  number: 128,
  kind: "OCCURRENCE",
  status: "OPEN",
  subject: "Cliente ausente — Mercado Sol",
  businessId: "b1",
  threadId: "t1",
  driverId: "dr1",
  deliveryId: "d1",
  occurrenceId: "o1",
  routeId: null,
  opened_via: "OCCURRENCE_REPORT",
  openedById: "u1",
  assigneeId: "u2",
  assigned_at: new Date("2026-09-24T10:02:00Z"),
  first_staff_reply_at: null,
  closedById: null,
  closed_at: null,
  close_outcome: null,
  close_note: null,
  reopened_count: 0,
  last_message_at: new Date("2026-09-24T10:00:00Z"),
  last_driver_message_at: new Date("2026-09-24T10:00:00Z"),
  last_staff_message_at: null,
  version: 3,
  client_submission_id: null,
  created_at: new Date("2026-09-24T09:59:00Z"),
  updated_at: new Date("2026-09-24T10:02:00Z"),
  driver: { id: "dr1", name: "Motorista" },
  driverUserId: "u1",
  delivery: { id: "d1", recipient_name: "Mercado Sol", status: "IN_TRANSIT" },
  route: null,
  occurrence: {
    id: "o1",
    typeName: "Cliente ausente",
    authorization_status: "PENDING",
    created_at: new Date("2026-09-24T09:59:00Z"),
  },
  assignee: { id: "u2", name: "Operadora" },
  openedBy: { id: "u1", name: "Motorista" },
  closedBy: null,
};

/** What JSON.stringify makes of it — the wire, not the object. */
const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

function documented(runtime: z.ZodTypeAny): z.ZodTypeAny {
  const doc = documentedDocFor(runtime);

  if (!doc) throw new Error("schema sem documentação registrada");

  return doc;
}

describe("the chat as documented", () => {
  it("describes a message exactly as the presenter sends it", async () => {
    const presented = await presentChatMessage(view, signer);

    expect(strictIssues(chatDocumented.message, wire(presented))).toEqual([]);

    // And the checker does catch a field the document does not list.
    expect(
      strictIssues(chatDocumented.message, {
        ...(wire(presented) as object),
        sender: { id: "u1", name: "Motorista", email: "vazou@exemplo" },
      }),
    ).not.toEqual([]);

    // The storage key never leaves the API; the document must not say it does.
    expect(JSON.stringify(chatDocumented.message.shape)).not.toContain(
      "attachment_key",
    );
  });

  it("describes the conversation page", async () => {
    type Page = Awaited<ReturnType<ListChatMessagesUseCase["execute"]>>;

    const page: Page = {
      threadId: "t1",
      data: [await presentChatMessage(view, signer)],
      nextCursor: { created_at: "2026-09-24T10:00:00.000Z", id: "m1" },
      previousCursor: null,
      hasNewer: false,
      counterpartLastReadAt: new Date("2026-09-24T10:01:00Z"),
      driverUser: { id: "u1", last_seen_at: null },
      counterpartDeliveredAt: null,
      tickets: [presentTicket(ticketRow), driverTicketView(presentTicket(ticketRow))],
      counterpartTicketReadAt: { [ticketRow.id]: new Date("2026-09-24T10:02:00Z") },
    };

    expect(
      strictIssues(documented(chatResponses.messageList), wire(page)),
    ).toEqual([]);
  });

  it("describes the thread list, presence included", () => {
    // list-chat-threads-controller stitches `online` into driverUser.
    const body = {
      data: [
        {
          ...threadEntry,
          driverUser: { ...threadEntry.driverUser!, online: true },
        },
      ],
      total: 1,
      totalUnread: 2,
    };

    expect(
      strictIssues(documented(chatResponses.threadList), wire(body)),
    ).toEqual([]);
  });

  it("describes a search hit", async () => {
    type Hits = Awaited<ReturnType<SearchChatMessagesUseCase["execute"]>>;

    const hits: Hits = {
      data: [
        {
          ...(await presentChatMessage(view, signer)),
          driver: { id: "dr1", name: "Motorista" },
        },
      ],
    };

    expect(
      strictIssues(documented(chatResponses.searchResult), wire(hits)),
    ).toEqual([]);
  });

  it("describes a send, with each recipient's outcome", async () => {
    const sent = {
      ...(await presentChatMessage(view, signer)),
      driver: { id: "dr1", name: "Motorista" },
      ticket: { id: "tk1", number: 128, status: "OPEN" as const, assigneeId: null, version: 1 },
      senderSide: "STAFF" as const,
    };

    const body: { message: string } & SendChatMessageResponse = {
      message: "Mensagem enviada!",
      data: [sent],
      outcomes: [
        { driverId: "dr1", driverName: "Motorista", status: "SENT", messageId: "m1" },
        {
          driverId: "dr2",
          driverName: "Sem App",
          status: "SKIPPED_NO_APP",
          messageId: null,
        },
      ],
      summary: { sent: 1, alreadySent: 0, skippedNoApp: 1 },
    };

    expect(
      strictIssues(documented(chatResponses.messageSent), wire(body)),
    ).toEqual([]);
  });

  it("describes the recipients page", () => {
    const body: ListChatRecipientsResponse = {
      data: [{ id: "dr1", name: "Motorista", hasApp: true }],
      nextCursor: null,
      hasMore: false,
      audience: { withApp: 1, withoutApp: 0 },
    };

    expect(
      strictIssues(documented(chatResponses.recipients), wire(body)),
    ).toEqual([]);
  });

  it("describes a ticket exactly as the presenter sends it, and the driver's reduced view", () => {
    const summary = presentTicket(ticketRow, {
      unreadCount: 2,
      lastMessage: {
        kind: "TEXT",
        body: "Cliente não atende",
        sender: { id: "u1", name: "Motorista" },
        created_at: new Date("2026-09-24T10:00:00Z"),
      },
    });

    expect(strictIssues(supportTicketDocumented.summary, wire(summary))).toEqual([]);

    const list = { data: [summary], total: 1, counts: { open: 1, unassigned: 0, mine: 0, pendingAuthorization: 1, unreadOpen: 1 } };

    expect(strictIssues(documented(supportTicketResponses.list), wire(list))).toEqual([]);

    // The driver's view never carries who handles the ticket.
    const forDriver = driverTicketView(summary);

    expect(JSON.stringify(forDriver)).not.toContain("Operadora");
    expect(forDriver).not.toHaveProperty("assignee");
  });

  it("keeps the runtime schemas pass-through, so no field is stripped", () => {
    // The whole reason the typed shapes are documentation only.
    const parsed = chatResponses.searchResult.parse({
      data: [{ a_field_nobody_documented: 1 }],
    }) as { data: Array<Record<string, unknown>> };

    expect(parsed.data[0].a_field_nobody_documented).toBe(1);
  });
});
