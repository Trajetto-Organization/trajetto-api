import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /address-search/:businessId's handler and the person who gave up
 * (plan pin-search): the browser's fetch is cancelled by the next
 * keystroke, and a search nobody reads must take no slot, make no call and
 * spend nothing of the company's day.
 *
 * The handler listens for the reply's socket closing, but only once it
 * runs — after the guards. A request given up while they ran had closed
 * its socket already, and the listener never heard it.
 */
const executions = vi.hoisted(() => [] as Array<{ signal: AbortSignal }>);
const during = vi.hoisted(() => ({ run: () => undefined as void }));

vi.mock(
  "@/modules/address-search/usecases/search-address/search-address-runtime",
  () => ({
    searchAddressUseCase: () => ({
      execute: async (request: { signal: AbortSignal }) => {
        executions.push(request);
        during.run();

        return {
          kind: "OK",
          results: [],
          weak: false,
          scope: "COUNTRY",
          cached: false,
        };
      },
    }),
  }),
);

import { SearchAddressController } from "@/modules/address-search/usecases/search-address/search-address-controller";

const BUSINESS = "018ff000-0000-7000-8000-00000000000a";

function exchange({ socketGone = false, replyGone = false } = {}) {
  const raw = Object.assign(new EventEmitter(), {
    destroyed: replyGone,
    writableEnded: false,
  });

  const sent: Array<{ status: number; body: unknown }> = [];
  let status = 200;

  const reply = {
    raw,
    status(code: number) {
      status = code;
      return reply;
    },
    send(body?: unknown) {
      sent.push({ status, body });
      return reply;
    },
  };

  const request = {
    params: { businessId: BUSINESS },
    query: { q: "Rua Epitácio Pessoa, 120" },
    raw: { socket: { destroyed: socketGone } },
  };

  return { request, reply, sent };
}

describe("a search the person gave up on", () => {
  beforeEach(() => {
    executions.length = 0;
    during.run = () => undefined;
  });

  it("is answered 499 without searching when the socket closed during the guards", async () => {
    for (const gone of [{ socketGone: true }, { replyGone: true }]) {
      const { request, reply, sent } = exchange(gone);

      await new SearchAddressController().handle(
        request as never,
        reply as never,
      );

      expect(sent).toEqual([{ status: 499, body: undefined }]);
    }

    expect(executions).toHaveLength(0);
  });

  it("searches with a live signal otherwise, aborted once the socket closes", async () => {
    const { request, reply, sent } = exchange();
    let live: boolean | null = null;

    during.run = () => {
      live = !executions[0].signal.aborted;
      reply.raw.emit("close");
    };

    await new SearchAddressController().handle(
      request as never,
      reply as never,
    );

    expect(executions).toHaveLength(1);
    expect(live).toBe(true);
    expect(executions[0].signal.aborted).toBe(true);
    expect(sent[0].status).toBe(200);
    // Answered: the listener is gone with the request.
    expect(reply.raw.listenerCount("close")).toBe(0);
  });
});
