import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createSubscriptionIntents } from "@/shared/socket/subscription-intent";

/**
 * An unsubscribe sent while a subscribe reads the database (wave 4 review).
 *
 * The subscribe awaited the staff check and joined afterwards; the
 * unsubscribe, synchronous, found no room yet and did nothing. The app sends
 * that pair when a push opens a screen over the operations tab, and the phone
 * kept the fleet's feed on a screen that draws none of it. The rule is pure
 * and tested here; `socket-mobile-rooms.test.ts` proves it through the real
 * channel.
 */
const BUSINESS = "018feb00-0000-7000-8000-00000000000a";
const OTHER = "018feb00-0000-7000-8000-00000000000b";

describe("a subscribe still waiting on the database", () => {
  it("joins when nothing was sent after it", () => {
    const intents = createSubscriptionIntents();
    const socket = {};

    const ticket = intents.begin(socket, "operations", BUSINESS);

    expect(intents.isCurrent(socket, "operations", ticket)).toBe(true);
  });

  it("joins nothing once an unsubscribe of the same company arrived", () => {
    const intents = createSubscriptionIntents();
    const socket = {};

    const ticket = intents.begin(socket, "operations", BUSINESS);
    intents.cancel(socket, "operations", BUSINESS);

    expect(intents.isCurrent(socket, "operations", ticket)).toBe(false);
  });

  it("is left alone by another company's unsubscribe", () => {
    const intents = createSubscriptionIntents();
    const socket = {};

    const ticket = intents.begin(socket, "operations", BUSINESS);
    intents.cancel(socket, "operations", OTHER);

    expect(intents.isCurrent(socket, "operations", ticket)).toBe(true);
  });

  it("gives way to a newer subscribe, so the last message wins", () => {
    // A MASTER switching companies: whichever read comes back first, only
    // the company asked for last is joined.
    const intents = createSubscriptionIntents();
    const socket = {};

    const first = intents.begin(socket, "operations", BUSINESS);
    const second = intents.begin(socket, "operations", OTHER);

    expect(intents.isCurrent(socket, "operations", first)).toBe(false);
    expect(intents.isCurrent(socket, "operations", second)).toBe(true);
  });

  it("is told apart from a later subscribe of the same company", () => {
    // subscribe, unsubscribe, subscribe: the first read must not join on the
    // strength of the third message's wish.
    const intents = createSubscriptionIntents();
    const socket = {};

    const first = intents.begin(socket, "operations", BUSINESS);
    intents.cancel(socket, "operations", BUSINESS);
    const third = intents.begin(socket, "operations", BUSINESS);

    expect(intents.isCurrent(socket, "operations", first)).toBe(false);
    expect(intents.isCurrent(socket, "operations", third)).toBe(true);
  });

  it("keeps the operations and the SAC rooms apart", () => {
    const intents = createSubscriptionIntents();
    const socket = {};

    const operations = intents.begin(socket, "operations", BUSINESS);
    const chat = intents.begin(socket, "chat", BUSINESS);

    intents.cancel(socket, "chat", BUSINESS);

    expect(intents.isCurrent(socket, "operations", operations)).toBe(true);
    expect(intents.isCurrent(socket, "chat", chat)).toBe(false);
  });

  it("keeps sockets apart", () => {
    const intents = createSubscriptionIntents();
    const phone = {};
    const tab = {};

    const atPhone = intents.begin(phone, "operations", BUSINESS);
    const atTab = intents.begin(tab, "operations", BUSINESS);

    intents.cancel(phone, "operations", BUSINESS);

    expect(intents.isCurrent(phone, "operations", atPhone)).toBe(false);
    expect(intents.isCurrent(tab, "operations", atTab)).toBe(true);
  });

  it("joins nothing after the socket lost the staff right", () => {
    // A read from before a revocation must not walk back into the room.
    const intents = createSubscriptionIntents();
    const socket = {};

    const operations = intents.begin(socket, "operations", BUSINESS);
    const chat = intents.begin(socket, "chat", BUSINESS);

    intents.cancelAll(socket);

    expect(intents.isCurrent(socket, "operations", operations)).toBe(false);
    expect(intents.isCurrent(socket, "chat", chat)).toBe(false);
  });

  it("an unsubscribe with nothing pending changes nothing", () => {
    const intents = createSubscriptionIntents();
    const socket = {};

    expect(() => intents.cancel(socket, "operations", BUSINESS)).not.toThrow();

    const ticket = intents.begin(socket, "operations", BUSINESS);

    expect(intents.isCurrent(socket, "operations", ticket)).toBe(true);
  });
});

describe("the socket server wires the ticket where the rooms are joined", () => {
  // The handlers read the database, so the race itself is proved in the E2E
  // suite; this keeps the cheap suite failing first if a handler is edited
  // back to joining without asking.
  const source = readFileSync(
    resolve(process.cwd(), "src/websocket.ts"),
    "utf8",
  );

  const handler = (event: string): string => {
    const start = source.indexOf(`socket.on("${event}"`);

    expect(start).toBeGreaterThan(-1);

    const end = source.indexOf("socket.on(", start + 1);

    return source.slice(start, end === -1 ? undefined : end);
  };

  it.each([
    ["chatSubscribe", "chat"],
    ["operationsSubscribe", "operations"],
  ])(
    "%s takes its ticket before the staff check and checks it before joining",
    (event, kind) => {
      const body = handler(event);

      const begin = body.indexOf(`subscribeIntents.begin(`);
      const wait = body.indexOf("await currentDeliveryStaff(socket)");
      const check = body.indexOf(
        `subscribeIntents.isCurrent(socket, "${kind}", ticket)`,
      );
      const join = body.indexOf("socket.join(");

      expect(body).toMatch(new RegExp(`"${kind}",\\s*requestedBusinessId`));
      expect(begin).toBeGreaterThan(-1);
      expect(begin).toBeLessThan(wait);
      expect(check).toBeGreaterThan(wait);
      expect(check).toBeLessThan(join);
    },
  );

  it.each([
    ["chatUnsubscribe", "chat"],
    ["operationsUnsubscribe", "operations"],
  ])(
    "%s calls off a waiting subscribe even when the room was not joined yet",
    (event, kind) => {
      const body = handler(event);

      const cancel = body.indexOf(
        `subscribeIntents.cancel(socket, "${kind}", requestedBusinessId)`,
      );
      const lock = body.indexOf("mayLeaveOwnDispatchRooms(");
      const roomCheck = body.indexOf(
        `socket.data.${kind}BusinessId !== requestedBusinessId`,
      );

      expect(cancel).toBeGreaterThan(-1);

      // After the web's lock (a refused unsubscribe calls nothing off), and
      // before the check that returns when there is no room to leave.
      expect(cancel).toBeGreaterThan(lock);
      expect(cancel).toBeLessThan(roomCheck);
    },
  );

  it("losing the staff right calls off every waiting subscribe", () => {
    const start = source.indexOf("function leaveDeliveryRooms(");
    const end = source.indexOf("\n}\n", start);

    expect(source.slice(start, end)).toContain(
      "subscribeIntents.cancelAll(socket)",
    );
  });
});
