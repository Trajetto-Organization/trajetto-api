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
  template: env.META_WHATSAPP_TEMPLATE_NAME,
  customerTemplate: env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME,
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
    template: { name: string };
  };
}

beforeEach(() => {
  env.META_WHATSAPP_ACCESS_TOKEN = "token-de-teste";
  env.META_WHATSAPP_PHONE_NUMBER_ID = "1234567890";
  env.META_WHATSAPP_TEMPLATE_NAME = "trajetto_notification";
  env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME = undefined;
});

afterEach(() => {
  env.META_WHATSAPP_ACCESS_TOKEN = saved.token;
  env.META_WHATSAPP_PHONE_NUMBER_ID = saved.phone;
  env.META_WHATSAPP_TEMPLATE_NAME = saved.template;
  env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME = saved.customerTemplate;

  vi.unstubAllGlobals();
});

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
      message: "Sua entrega saiu",
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
      message: "Teste",
    });

    expect(sentBody(fetchMock)).not.toHaveProperty("biz_opaque_callback_data");
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
      message: "Sua entrega saiu",
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

    await provider.sendMessage({ phoneNumber: "11999990000", message: "1" });

    const second = await provider.sendMessage({
      phoneNumber: "11999990001",
      message: "2",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.retryable).toBe(true);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("the customer's template", () => {
  /**
   * A carrier's message to its own customer used to ride the SAME template as
   * the product's internal notices ("...Acesse o sistema..."): a customer
   * reporting one as spam put the template every driver depends on at risk.
   */
  it("goes out under its own template when one is configured", async () => {
    env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME = "trajetto_cliente";

    const fetchMock = stubFetch([
      { status: 200, body: { messages: [{ id: "wamid.1" }] } },
    ]);

    const provider = new MetaCloudApiProvider();

    await provider.sendMessage({
      phoneNumber: "11999990000",
      message: "Sua entrega saiu",
      audience: "customer",
    });

    await provider.sendMessage({
      phoneNumber: "11999990000",
      message: "Nova multa",
    });

    expect(sentBody(fetchMock, 0).template.name).toBe("trajetto_cliente");
    expect(sentBody(fetchMock, 1).template.name).toBe("trajetto_notification");
  });

  it("falls back to the shared template until one is configured", async () => {
    const fetchMock = stubFetch([
      { status: 200, body: { messages: [{ id: "wamid.1" }] } },
    ]);

    await new MetaCloudApiProvider().sendMessage({
      phoneNumber: "11999990000",
      message: "Sua entrega saiu",
      audience: "customer",
    });

    expect(sentBody(fetchMock).template.name).toBe("trajetto_notification");
  });

  it("does not stop the internal notices when Meta pauses it", async () => {
    env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME = "trajetto_cliente";

    const fetchMock = stubFetch([
      { status: 400, body: TEMPLATE_PAUSED },
      { status: 200, body: { messages: [{ id: "wamid.2" }] } },
    ]);

    const provider = new MetaCloudApiProvider();

    await provider.sendMessage({
      phoneNumber: "11999990000",
      message: "Sua entrega saiu",
      audience: "customer",
    });

    const internal = await provider.sendMessage({
      phoneNumber: "11999990000",
      message: "Nova multa",
    });

    expect(internal.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
