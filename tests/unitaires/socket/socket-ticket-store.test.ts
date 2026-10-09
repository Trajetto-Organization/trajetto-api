import { describe, expect, it } from "vitest";

import {
  InMemorySocketTicketStore,
  SOCKET_TICKET_TTL_SECONDS,
  type ISocketTicketStore,
} from "@/shared/socket/socket-ticket";
import { CreateSocketTicketUseCase } from "@/modules/user/usecases/create-socket-ticket/create-socket-ticket-usecase";

/**
 * The in-memory twin must keep the Redis store's contract (the E2E proves the
 * Redis one): one use, a 30 s life, and nothing for a malformed ticket.
 */
const claims = {
  userId: "u-1",
  businessId: "b-1",
  sessionId: "family-1",
  sessionVersion: 3,
};

describe("InMemorySocketTicketStore", () => {
  it("hands the claims back once and then never again", async () => {
    const store = new InMemorySocketTicketStore();
    const { ticket, expiresInSeconds } = await store.issue(claims);

    expect(expiresInSeconds).toBe(SOCKET_TICKET_TTL_SECONDS);
    expect(await store.consume(ticket)).toEqual(claims);
    expect(await store.consume(ticket)).toBeNull();
  });

  it("refuses a ticket past its life", async () => {
    let now = 1_000_000;
    const store = new InMemorySocketTicketStore(() => now);
    const { ticket } = await store.issue(claims);

    now += SOCKET_TICKET_TTL_SECONDS * 1000;

    expect(await store.consume(ticket)).toBeNull();
  });

  it("refuses an invented or malformed ticket", async () => {
    const store = new InMemorySocketTicketStore();

    expect(await store.consume("x".repeat(43))).toBeNull();
    expect(await store.consume("")).toBeNull();
  });
});

describe("CreateSocketTicketUseCase", () => {
  it("answers 503 SOCKET_TICKET_UNAVAILABLE when the store is down", async () => {
    const broken: ISocketTicketStore = {
      issue: async () => {
        throw new Error("Connection is closed.");
      },
      consume: async () => null,
    };

    await expect(
      new CreateSocketTicketUseCase(broken).execute(claims),
    ).rejects.toMatchObject({ statusCode: 503, code: "SOCKET_TICKET_UNAVAILABLE" });
  });
});
