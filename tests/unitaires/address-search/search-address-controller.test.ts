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
const during = vi.hoisted(() => ({
  run: () => undefined as void,
  result: null as Record<string, unknown> | null,
}));

vi.mock(
  "@/modules/address-search/usecases/search-address/search-address-runtime",
  () => ({
    searchAddressUseCase: () => ({
      execute: async (request: { signal: AbortSignal }) => {
        executions.push(request);
        during.run();

        return (
          during.result ?? {
            kind: "OK",
            results: [],
            weak: false,
            scope: "COUNTRY",
            cached: false,
          }
        );
      },
    }),
  }),
);

import { SearchAddressController } from "@/modules/address-search/usecases/search-address/search-address-controller";
import { ServiceBusyError } from "@/shared/errors/service-busy-error";

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
    during.result = null;
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

describe("a search that cannot answer", () => {
  beforeEach(() => {
    executions.length = 0;
    during.run = () => undefined;
  });

  async function refusal(result: Record<string, unknown>) {
    during.result = result;

    const { request, reply } = exchange();

    return new SearchAddressController()
      .handle(request as never, reply as never)
      .then(
        () => null,
        (error: unknown) => error as ServiceBusyError,
      );
  }

  // Owner's report of 14/11/2026: the search off by configuration answered
  // the same 503 as a pause, and the web said "por enquanto" for a search
  // that would never come back on by itself.
  it("answers the search off with ADDRESS_SEARCH_DISABLED, an hour's retry-after and the reason for the log only", async () => {
    const error = await refusal({
      kind: "UNAVAILABLE",
      reason: "DISABLED",
      retryAfterSeconds: 3600,
      diagnostic: "ADDRESS_SEARCH_URL is not set",
    });

    expect(error).toBeInstanceOf(ServiceBusyError);
    expect(error).toMatchObject({
      statusCode: 503,
      code: "ADDRESS_SEARCH_DISABLED",
      retryAfterSeconds: 3600,
      message:
        "A busca de endereço não está disponível. Clique no mapa onde fica o endereço.",
      diagnostic: "ADDRESS_SEARCH_URL is not set",
    });
    // The message is what the body carries: never the variable.
    expect(error?.message).not.toContain("ADDRESS_SEARCH_URL");
  });

  it("keeps ADDRESS_SEARCH_UNAVAILABLE for a pause or a provider down, with its diagnostic", async () => {
    for (const reason of ["PAUSED", "PROVIDER", "LIMITS_UNREADABLE"]) {
      const error = await refusal({
        kind: "UNAVAILABLE",
        reason,
        retryAfterSeconds: 900,
        diagnostic: reason === "PAUSED" ? "address search paused" : undefined,
      });

      expect(error).toMatchObject({
        statusCode: 503,
        code: "ADDRESS_SEARCH_UNAVAILABLE",
        retryAfterSeconds: 900,
      });
      expect(error?.diagnostic).toBe(
        reason === "PAUSED" ? "address search paused" : undefined,
      );
    }
  });
});
