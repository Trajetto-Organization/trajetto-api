import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EXPO_MAX_MESSAGES_PER_REQUEST,
  sendExpoPushBatch,
  type PushBatchOutcome,
  type PushRequest,
} from "@/shared/notifications/push-provider";

/**
 * Several deliveries in one call to Expo (plano-escala U-06).
 *
 * Expo answers one ticket per message, in the order sent, and a ticket's id
 * says nothing about which message it is for. Once a call carries the
 * messages of several deliveries, a slip in the position map puts one
 * driver's receipt on another driver's delivery: check-push-receipts-job
 * would then prune the wrong phone, and the duplicate-send ledger would
 * blame the wrong row. The fake Expo below records which id it gave to
 * which (delivery, token) and answers with ids that carry no order, some
 * of them errors, so only a mapping by position can come out right.
 */
type Message = {
  to: string;
  tag?: string;
  collapseId?: string;
  data: { deliveryId: string };
};

type Ticket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details: { error: string } };

const expo = {
  calls: [] as Message[][],
  /** `${deliveryId}|${token}` → the ticket id Expo handed out for it. */
  given: new Map<string, string>(),
  dead: new Set<string>(),
  /** Messages Expo took (a ticket "ok"), over every call. */
  accepted: 0,
  answer: null as ((messages: Message[]) => Response | null) | null,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  expo.calls = [];
  expo.given = new Map();
  expo.dead = new Set();
  expo.accepted = 0;
  expo.answer = null;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const messages = JSON.parse(String(init?.body)) as Message[];

      expo.calls.push(messages);

      // Expo's own limit: more than 100 in a call is refused whole.
      if (messages.length > EXPO_MAX_MESSAGES_PER_REQUEST) {
        return json(400, {
          errors: [{ code: "PUSH_TOO_MANY_NOTIFICATIONS" }],
        });
      }

      const custom = expo.answer?.(messages);
      if (custom) return custom;

      return json(200, {
        data: messages.map((message): Ticket => {
          if (expo.dead.has(message.to)) {
            return {
              status: "error",
              message: "not registered",
              details: { error: "DeviceNotRegistered" },
            };
          }

          const id = randomUUID();

          expo.given.set(`${message.data.deliveryId}|${message.to}`, id);
          expo.accepted += 1;

          return { status: "ok", id };
        }),
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestFor(
  deliveryId: string,
  devices: number,
  ios: number[] = [],
): PushRequest {
  const tokens = Array.from(
    { length: devices },
    (_, index) => `ExponentPushToken[${deliveryId}-${index}]`,
  );

  return {
    tokens,
    content: {
      title: "Rota liberada",
      body: "Sua rota de hoje está pronta.",
      data: { url: "/notifications", deliveryId },
      collapseKey: deliveryId,
    },
    iosTokens: new Set(ios.map((index) => tokens[index])),
  };
}

function okResult(outcome: PushBatchOutcome) {
  if (!outcome.ok) throw outcome.error;

  return outcome.result;
}

describe("a push batch", () => {
  it("gives every delivery exactly the tickets of its own messages", async () => {
    // 1 to 3 phones each, a dead one here and there, iPhones mixed in.
    const requests = Array.from({ length: 24 }, (_, index) =>
      requestFor(`d${index}`, (index % 3) + 1, index % 4 === 0 ? [0] : []),
    );

    expo.dead.add(requests[5].tokens[1]);
    expo.dead.add(requests[11].tokens[0]);

    const outcomes = await sendExpoPushBatch(requests);

    expect(expo.calls).toHaveLength(1);
    expect(outcomes).toHaveLength(requests.length);

    let tickets = 0;

    requests.forEach((request, index) => {
      const deliveryId = String(request.content.data.deliveryId);
      const result = okResult(outcomes[index]);

      // Each ticket is the one Expo gave to this delivery's message to that
      // very phone: never a neighbour's.
      for (const ticket of result.tickets) {
        expect(request.tokens).toContain(ticket.token);
        expect(ticket.id).toBe(expo.given.get(`${deliveryId}|${ticket.token}`));
      }

      // And none of its accepted messages is missing.
      const accepted = request.tokens.filter((token) => !expo.dead.has(token));

      expect(result.tickets.map((ticket) => ticket.token).sort()).toEqual(
        accepted.sort(),
      );
      expect(result.invalidTokens).toEqual(
        request.tokens.filter((token) => expo.dead.has(token)),
      );
      expect(result.deliveredAny).toBe(accepted.length > 0);

      tickets += result.tickets.length;
    });

    // 0 receipts lost: every id Expo handed out came back to a delivery.
    expect(tickets).toBe(expo.given.size);

    // Each message keeps its own delivery's tag and data; collapseId only
    // on that delivery's iPhone.
    for (const message of expo.calls[0]) {
      expect(message.tag).toBe(message.data.deliveryId);
      expect(message.to.startsWith(`ExponentPushToken[${message.tag}-`)).toBe(
        true,
      );
    }

    expect(
      expo.calls[0].filter((message) => message.collapseId).map((m) => m.to),
    ).toEqual(
      requests.flatMap((request) =>
        request.tokens.filter((token) => request.iosTokens?.has(token)),
      ),
    );
  });

  it("packs whole deliveries into calls of at most 100 messages", async () => {
    // 30 deliveries of 4 phones: 120 messages, two calls; 25 deliveries
    // fill the first exactly.
    const requests = Array.from({ length: 30 }, (_, index) =>
      requestFor(`p${index}`, 4),
    );

    const outcomes = await sendExpoPushBatch(requests);

    expect(expo.calls.map((call) => call.length)).toEqual([100, 20]);

    // No delivery split across two calls.
    for (const call of expo.calls) {
      const deliveries = new Set(
        call.map((message) => message.data.deliveryId),
      );

      for (const deliveryId of deliveries) {
        expect(
          call.filter((message) => message.data.deliveryId === deliveryId),
        ).toHaveLength(4);
      }
    }

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(
      outcomes.reduce(
        (sum, outcome) => sum + okResult(outcome).tickets.length,
        0,
      ),
    ).toBe(120);
  });

  it("sends a delivery of more than 100 phones in a call of its own, as before", async () => {
    const requests = [
      requestFor("small-1", 2),
      requestFor("huge", EXPO_MAX_MESSAGES_PER_REQUEST + 1),
      requestFor("small-2", 2),
    ];

    const outcomes = await sendExpoPushBatch(requests);

    expect(expo.calls.map((call) => call.length)).toEqual([2, 101, 2]);
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[2].ok).toBe(true);
    expect(outcomes[1]).toMatchObject({
      ok: false,
      error: { httpStatus: 400 },
    });
  });

  it("fails every delivery of a call Expo answered 503, and no other", async () => {
    const requests = Array.from({ length: 30 }, (_, index) =>
      requestFor(`s${index}`, 4),
    );

    // The second call (the last five deliveries) meets an Expo incident.
    expo.answer = (messages) =>
      messages.some((message) => message.data.deliveryId === "s29")
        ? json(503, { errors: [{ code: "INTERNAL_SERVER_ERROR" }] })
        : null;

    const outcomes = await sendExpoPushBatch(requests);

    outcomes.forEach((outcome, index) => {
      if (index < 25) {
        expect(outcome.ok).toBe(true);
      } else {
        expect(outcome).toMatchObject({
          ok: false,
          error: { httpStatus: 503 },
        });
      }
    });
  });

  it("sends a call Expo refused with 400 again, one delivery per call, so only the culprit fails", async () => {
    const requests = Array.from({ length: 6 }, (_, index) =>
      requestFor(`r${index}`, 2),
    );

    // A token of another Expo project rode along: Expo refuses the whole
    // request (PUSH_TOO_MANY_EXPERIENCE_IDS) and sends none of it.
    const foreign = requests[3].tokens[0];

    expo.answer = (messages) =>
      messages.some((message) => message.to === foreign)
        ? json(400, { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] })
        : null;

    const outcomes = await sendExpoPushBatch(requests);

    // One refused call of six, then six calls of one.
    expect(expo.calls.map((call) => call.length)).toEqual([
      12, 2, 2, 2, 2, 2, 2,
    ]);

    outcomes.forEach((outcome, index) => {
      if (index === 3) {
        expect(outcome).toMatchObject({
          ok: false,
          error: { httpStatus: 400 },
        });
      } else {
        expect(okResult(outcome).tickets).toHaveLength(2);
      }
    });

    // The refused call sent nothing, so each phone that got a message got
    // it once: ten accepted messages, the culprit's two not among them.
    expect(expo.accepted).toBe(10);
    expect(expo.given.size).toBe(10);
  });

  it("assigns no ticket when Expo answers a different count than it was sent", async () => {
    const requests = [requestFor("m0", 2), requestFor("m1", 1)];

    expo.answer = () =>
      json(200, {
        data: [
          { status: "ok", id: randomUUID() },
          { status: "ok", id: randomUUID() },
        ],
      });

    const outcomes = await sendExpoPushBatch(requests);

    expect(outcomes).toHaveLength(2);

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.error.message).toMatch(
        /2 tickets para 3 mensagens/,
      );
    }
  });

  it("fails the deliveries of a call that never got an answer, without a status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const outcomes = await sendExpoPushBatch([
      requestFor("n0", 1),
      requestFor("n1", 2),
    ]);

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ ok: false });
      expect(outcome.ok ? 0 : outcome.error.httpStatus).toBeUndefined();
    }
  });
});
