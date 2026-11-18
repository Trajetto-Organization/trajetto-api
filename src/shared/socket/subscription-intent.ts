/**
 * What a socket last asked of its dispatch rooms, while a subscribe waits on
 * the database (wave 4 review, 06/11/2026).
 *
 * `operationsSubscribe` and `chatSubscribe` re-read the staff fact before
 * joining, so they await; the unsubscribes do not. An unsubscribe that landed
 * during that read found no room to leave and did nothing, and the subscribe
 * then joined. The app sends exactly that pair when a push opens a screen on
 * top of the operations tab (focus, then blur a few milliseconds later), and
 * the phone kept receiving every position, route event and authorization of
 * the fleet on a screen that draws none of it: the fan-out wave 4 removed.
 *
 * So each subscribe takes a ticket before it waits and joins only if that
 * ticket is still the socket's latest wish when the database answers. An
 * unsubscribe of the same company tears the ticket up, and so does a newer
 * subscribe (a MASTER switching companies): the last message the client sent
 * is the one that wins, whatever order the reads come back in. Losing the
 * staff right tears up every ticket, so a subscribe answered from a read that
 * predates a revocation joins nothing either.
 *
 * Kept beside the socket in a WeakMap, like the hint budget and the cached
 * staff check, rather than in `socket.data`, which `fetchSockets` serialises
 * into every answer it sends through Redis. It dies with the socket.
 */

// `positions` since plano-escala U-01: the tower's and the route detail's
// dots, under the operations room's rule.
type DispatchRoomKind = "operations" | "chat" | "positions";

/** One subscribe's claim. Compared by identity: two for one company differ. */
interface SubscriptionTicket {
  readonly businessId: string;
}

interface SubscriptionIntents {
  /** A subscribe arrived: from now on it is the one that counts. */
  begin(
    socket: object,
    kind: DispatchRoomKind,
    businessId: string,
  ): SubscriptionTicket;

  /** After the wait: whether that subscribe is still what the socket wants. */
  isCurrent(
    socket: object,
    kind: DispatchRoomKind,
    ticket: SubscriptionTicket,
  ): boolean;

  /** An unsubscribe of this company: a subscribe still waiting for it joins nothing. */
  cancel(socket: object, kind: DispatchRoomKind, businessId: string): void;

  /** The socket lost the right to every dispatch room. */
  cancelAll(socket: object): void;
}

function createSubscriptionIntents(): SubscriptionIntents {
  const pending = new WeakMap<
    object,
    Partial<Record<DispatchRoomKind, SubscriptionTicket>>
  >();

  return {
    begin(socket, kind, businessId) {
      const ticket: SubscriptionTicket = { businessId };
      const tickets = pending.get(socket) ?? {};

      tickets[kind] = ticket;
      pending.set(socket, tickets);

      return ticket;
    },

    isCurrent(socket, kind, ticket) {
      return pending.get(socket)?.[kind] === ticket;
    },

    cancel(socket, kind, businessId) {
      const tickets = pending.get(socket);

      // Another company's unsubscribe leaves a newer subscribe alone.
      if (tickets?.[kind]?.businessId === businessId) delete tickets[kind];
    },

    cancelAll(socket) {
      pending.delete(socket);
    },
  };
}

export { createSubscriptionIntents };
export type { DispatchRoomKind, SubscriptionIntents, SubscriptionTicket };
