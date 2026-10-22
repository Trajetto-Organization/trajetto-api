import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";
import { InMemorySupportTicketRepository } from "@/modules/chat/repositories/in-memory/in-memory-support-ticket-repository";

import type { SupportTicketEventType } from "@/modules/chat/dtos/support-ticket-dto";

/**
 * Rows written in the same millisecond keep their creation order.
 *
 * The columns default to uuid(7), and every listing orders by
 * (created_at, id): the id is the tie-breaker. The twins used randomUUID (v4),
 * so rows sharing a created_at came back in random order — a ticket trail read
 * ASSIGNED before OPENED. The clock is frozen here, so every row ties on
 * created_at and only the id can keep the order: with v4 ids, 24 rows come
 * back in order with probability 1/24!, i.e. never.
 */
const BUSINESS = "018f6100-0000-7000-8000-0000000000b0";
const TICKET = "018f6100-0000-7000-8000-0000000000c0";
const DRIVER = "018f6100-0000-7000-8000-0000000000d0";
const SENDER = "018f6100-0000-7000-8000-0000000000a0";

const ROWS = 24;

beforeEach(() => {
  vi.useFakeTimers({
    now: new Date("2026-10-06T12:00:00.000Z"),
    toFake: ["Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the in-memory ticket trail", () => {
  it("lists events created in the same millisecond in creation order", async () => {
    const tickets = new InMemorySupportTicketRepository();
    const types: SupportTicketEventType[] = [
      "OPENED",
      "ASSIGNED",
      "UNASSIGNED",
    ];
    const written: string[] = [];

    for (let index = 0; index < ROWS; index += 1) {
      const event = await tickets.addEvent({
        ticketId: TICKET,
        businessId: BUSINESS,
        type: types[index % types.length],
        actor_kind: "SYSTEM",
        note: `#${index}`,
      });

      written.push(event.id);
    }

    const trail = await tickets.listEvents(TICKET, BUSINESS, ROWS);

    expect(new Set(trail.map((event) => event.created_at.getTime())).size).toBe(
      1,
    );
    expect(trail.map((event) => event.id)).toEqual(written);
    expect(trail.map((event) => event.note)).toEqual(
      Array.from({ length: ROWS }, (_, index) => `#${index}`),
    );
  });
});

describe("the in-memory chat thread", () => {
  it("pages messages created in the same millisecond newest first, in creation order", async () => {
    const chat = new InMemoryChatRepository();
    const thread = await chat.getOrCreateThread(BUSINESS, DRIVER);

    for (let index = 0; index < ROWS; index += 1) {
      await chat.createMessage({
        threadId: thread.id,
        senderId: SENDER,
        kind: "TEXT",
        body: `#${index}`,
        attachment_key: null,
        duration_ms: null,
        deliveryId: null,
        broadcast_id: null,
        client_submission_id: null,
      });
    }

    const page = await chat.listMessages({
      threadId: thread.id,
      viewerIsDriverSide: false,
      limit: ROWS,
    });

    expect(page.data.map((message) => message.body)).toEqual(
      Array.from({ length: ROWS }, (_, index) => `#${ROWS - 1 - index}`),
    );
  });
});
