import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";

import { MetaCloudApiProvider } from "@/shared/providers/whatsapp-provider/implementations/meta-cloud-api-provider";

/**
 * What goes on the wire to Meta, read from the request the provider builds.
 *
 * The rules file proves the classification in isolation; this one proves the
 * request itself — the fields a later status callback is matched by — with
 * `fetch` stubbed and nothing leaving the machine.
 */
const saved = {
  token: env.META_WHATSAPP_ACCESS_TOKEN,
  phone: env.META_WHATSAPP_PHONE_NUMBER_ID,
};

const TEMPLATE_PAUSED = {
  error: {
    message: "Template is paused",
    code: 132015,
  },
};

type FetchCall = [string, { body: string }];

function stubFetch(
  answers: Array<{ status: number; body: unknown; headers?: HeadersInit }>,
) {
  let index = 0;

  const fetchMock = vi.fn(async () => {
    const answer = answers[Math.min(index++, answers.length - 1)];

    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json", ...answer.headers },
    });
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

function sentBody(fetchMock: { mock: { calls: unknown[][] } }, call = 0) {
  const [, init] = fetchMock.mock.calls[call] as unknown as FetchCall;

  return JSON.parse(init.body) as {
    biz_opaque_callback_data?: string;
    template: {
      name: string;
      language: { code: string };
      components: Array<Record<string, unknown>>;
    };
  };
}

beforeEach(() => {
  env.META_WHATSAPP_ACCESS_TOKEN = "token-de-teste";
  env.META_WHATSAPP_PHONE_NUMBER_ID = "1234567890";
});

afterEach(() => {
  env.META_WHATSAPP_ACCESS_TOKEN = saved.token;
  env.META_WHATSAPP_PHONE_NUMBER_ID = saved.phone;

  vi.unstubAllGlobals();
});

/** An internal notice: a template of its own, its parameters, no buttons. */
const FINE = {
  name: "trajetto_multa_registrada",
  parameters: ["RTA4F21", "Carlos", "Filial", "745-50", "14/10/2026"],
};

/** A customer message: the moment's template and its two URL buttons. */
const TOKEN = "0f".repeat(32);
const DISPATCHED = {
  name: "trajetto_cliente_saiu_para_entrega",
  parameters: ["Mercado Bom Preço", "Transportes Serra Azul", "NF-e 4521"],
  urlButtonSuffixes: [TOKEN, TOKEN],
};

describe("tying a WhatsApp send to its delivery", () => {
  /**
   * Meta has no idempotency key, so a send retried after a crash reaches the
   * customer twice. What it does have is a value echoed back on every status
   * callback: with the delivery id there, every wamid Meta reports can be
   * traced to the delivery that produced it — including the one whose send
   * succeeded right before the process died and was never recorded.
   */
  it("sends the delivery id as biz_opaque_callback_data", async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { messages: [{ id: "wamid.1" }] } },
    ]);

    const result = await new MetaCloudApiProvider().sendMessage({
      phoneNumber: "11999990000",
      template: FINE,
      referenceId: "018f0000-0000-7000-8000-0000000000d1",
    });

    expect(result.success).toBe(true);
    expect(sentBody(fetchMock).biz_opaque_callback_data).toBe(
      "018f0000-0000-7000-8000-0000000000d1",
    );
  });

  it("sends no callback data when there is no delivery behind the message", async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { messages: [{ id: "wamid.1" }] } },
    ]);

    await new MetaCloudApiProvider().sendMessage({
      phoneNumber: "11999990000",
      template: FINE,
    });

    expect(sentBody(fetchMock)).not.toHaveProperty("biz_opaque_callback_data");
  });
});

/**
 * Plan of 02/11/2026 (B1/B2). Every message went out under one generic
 * template with the whole text in a single parameter — vague enough that
 * Meta filed it as Marketing, and the customer's message had no button to
 * stop. Each message now names its own template, in pt_BR, with its
 * parameters in order; the customer's carry the token at the end of both
 * URL buttons.
 */
describe("the template on the wire", () => {
  it("names the message's own template, with every parameter in order", async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { messages: [{ id: "wamid.1" }] } },
    ]);

    await new MetaCloudApiProvider().sendMessage({
      phoneNumber: "11999990000",
      template: FINE,
    });

    const { template } = sentBody(fetchMock);

    expect(template.name).toBe("trajetto_multa_registrada");
    expect(template.language).toEqual({ code: "pt_BR" });
    expect(template.components).toEqual([
      {
        type: "body",
        parameters: FINE.parameters.map((text) => ({ type: "text", text })),
      },
    ]);
  });

  it("puts the token at the end of both URL buttons of a customer message", async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { messages: [{ id: "wamid.1" }] } },
    ]);

    await new MetaCloudApiProvider().sendMessage({
      phoneNumber: "11999990000",
      template: DISPATCHED,
    });

    const { template } = sentBody(fetchMock);

    expect(template.name).toBe("trajetto_cliente_saiu_para_entrega");
    expect(template.components.slice(1)).toEqual([
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: TOKEN }],
      },
      {
        type: "button",
        sub_type: "url",
        index: "1",
        parameters: [{ type: "text", text: TOKEN }],
      },
    ]);
  });

  it("never names the old generic template", async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { messages: [{ id: "wamid.1" }] } },
    ]);

    await new MetaCloudApiProvider().sendMessage({
      phoneNumber: "11999990000",
      template: DISPATCHED,
    });

    expect(JSON.stringify(sentBody(fetchMock))).not.toContain(
      "trajetto_notification",
    );
  });

  it("fails a template Meta does not have for good, without crashing", async () => {
    stubFetch([
      {
        status: 404,
        body: {
          error: {
            message: "Template name does not exist in the translation",
            code: 132001,
          },
        },
      },
    ]);

    const result = await new MetaCloudApiProvider().sendMessage({
      phoneNumber: "11999990000",
      template: FINE,
    });

    expect(result).toMatchObject({
      success: false,
      retryable: false,
      errorCode: 132001,
    });
  });
});

describe("a template Meta paused", () => {
  /**
   * Meta pauses a template whose messages draw complaints — for 3 hours the
   * first time, 6 the second — and every send in the meantime answers 132015.
   * That used to fail each delivery for good, on its first attempt: every
   * WhatsApp of every tenant sent during a pause was lost, although the pause
   * is temporary by definition.
   */
  it("is retried after the pause instead of failing the delivery", async () => {
    stubFetch([{ status: 400, body: TEMPLATE_PAUSED }]);

    const result = await new MetaCloudApiProvider().sendMessage({
      phoneNumber: "11999990000",
      template: DISPATCHED,
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("stops calling Meta for that template until the pause is over", async () => {
    // Every call during a pause is another refusal on the account's record,
    // and a batch of hundreds of them is a burst Meta sees.
    const fetchMock = stubFetch([{ status: 400, body: TEMPLATE_PAUSED }]);

    const provider = new MetaCloudApiProvider();

    await provider.sendMessage({
      phoneNumber: "11999990000",
      template: DISPATCHED,
    });

    const second = await provider.sendMessage({
      phoneNumber: "11999990001",
      template: DISPATCHED,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.retryable).toBe(true);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("does not stop the other templates", async () => {
    // A customer's spam report pauses that moment's template, never the
    // internal notices every driver and dispatcher depends on.
    const fetchMock = stubFetch([
      { status: 400, body: TEMPLATE_PAUSED },
      { status: 200, body: { messages: [{ id: "wamid.2" }] } },
    ]);

    const provider = new MetaCloudApiProvider();

    await provider.sendMessage({
      phoneNumber: "11999990000",
      template: DISPATCHED,
    });

    const internal = await provider.sendMessage({
      phoneNumber: "11999990000",
      template: FINE,
    });

    expect(internal.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
