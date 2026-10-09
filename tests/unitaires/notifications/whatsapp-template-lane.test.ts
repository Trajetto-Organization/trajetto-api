import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { container } from "tsyringe";

import { env } from "@/env";

import { MetaCloudApiProvider } from "@/shared/providers/whatsapp-provider/implementations/meta-cloud-api-provider";
import {
  applyWhatsAppTemplateLaneChange,
  templateLaneChanges,
} from "@/shared/providers/whatsapp-provider/template-lane";
import type { MetaTemplateUpdate } from "@/shared/providers/whatsapp-provider/meta-webhook";

/**
 * Meta's word on a template, turned into the lane's pause (OUTBOX-07 d,
 * OUTBOX-16).
 *
 * The provider learned a pause only from a send Meta refused (132015): every
 * replica spent one refusal — one more mark on the account's record, one
 * attempt of a delivery — to find out what Meta had already announced on the
 * template status webhook, which only logged it. And nothing lifted the pause
 * early: the backlog waited out the hour even after Meta reinstated the
 * template.
 */
const TEMPLATE = "trajetto_notification";

const saved = {
  token: env.META_WHATSAPP_ACCESS_TOKEN,
  phone: env.META_WHATSAPP_PHONE_NUMBER_ID,
  template: env.META_WHATSAPP_TEMPLATE_NAME,
  customerTemplate: env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME,
};

function update(fields: Partial<MetaTemplateUpdate>): MetaTemplateUpdate {
  return {
    event: "PAUSED",
    templateName: TEMPLATE,
    reason: null,
    language: "pt_BR",
    pauseTitle: null,
    occurredAt: null,
    ...fields,
  };
}

function stubFetch(status = 200, body: unknown = { messages: [{ id: "wamid.ok" }] }) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

const send = (provider: MetaCloudApiProvider) =>
  provider.sendMessage({ phoneNumber: "11999990000", message: "Olá" });

beforeEach(() => {
  env.META_WHATSAPP_ACCESS_TOKEN = "token-de-teste";
  env.META_WHATSAPP_PHONE_NUMBER_ID = "1234567890";
  env.META_WHATSAPP_TEMPLATE_NAME = TEMPLATE;
  env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME = undefined;
});

afterEach(() => {
  env.META_WHATSAPP_ACCESS_TOKEN = saved.token;
  env.META_WHATSAPP_PHONE_NUMBER_ID = saved.phone;
  env.META_WHATSAPP_TEMPLATE_NAME = saved.template;
  env.META_WHATSAPP_CUSTOMER_TEMPLATE_NAME = saved.customerTemplate;

  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("what a template status callback does to the lane", () => {
  it("pauses for as long as Meta says: 3 h the first time, 6 h the second", () => {
    expect(templateLaneChanges([update({ pauseTitle: "FIRST_PAUSE" })])).toEqual([
      { template: TEMPLATE, action: "pause", seconds: 3 * 3600 },
    ]);

    expect(templateLaneChanges([update({ pauseTitle: "SECOND_PAUSE" })])).toEqual([
      { template: TEMPLATE, action: "pause", seconds: 6 * 3600 },
    ]);
  });

  it("holds for the same hour a refused send would when Meta does not say how long", () => {
    expect(templateLaneChanges([update({})])).toEqual([
      { template: TEMPLATE, action: "pause", seconds: 3600 },
    ]);

    // Disabled: held an hour instead of refused send after send; the first
    // send after it meets 132016 and fails for good, as before.
    expect(templateLaneChanges([update({ event: "DISABLED" })])).toEqual([
      { template: TEMPLATE, action: "pause", seconds: 3600 },
    ]);
  });

  it("holds only what is left of a pause whose callback arrived late", () => {
    // Meta redelivers a callback it did not get a 200 for, for days: after a
    // database outage a PAUSED can land hours late — even after the
    // REINSTATED that ended it.
    const now = new Date("2026-09-24T12:00:00.000Z");
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3600 * 1000);

    expect(
      templateLaneChanges(
        [update({ pauseTitle: "FIRST_PAUSE", occurredAt: hoursAgo(2) })],
        now,
      ),
    ).toEqual([{ template: TEMPLATE, action: "pause", seconds: 3600 }]);

    expect(
      templateLaneChanges(
        [update({ pauseTitle: "FIRST_PAUSE", occurredAt: hoursAgo(4) })],
        now,
      ),
    ).toEqual([]);

    // A clock ahead of ours never lengthens the pause.
    expect(
      templateLaneChanges(
        [update({ pauseTitle: "FIRST_PAUSE", occurredAt: hoursAgo(-1) })],
        now,
      ),
    ).toEqual([{ template: TEMPLATE, action: "pause", seconds: 3 * 3600 }]);
  });

  it("lifts the pause when Meta reinstates or approves the template", () => {
    expect(
      templateLaneChanges([update({ event: "REINSTATED" }), update({ event: "APPROVED" })]),
    ).toEqual([
      { template: TEMPLATE, action: "resume" },
      { template: TEMPLATE, action: "resume" },
    ]);
  });

  it("leaves the lane alone for anything else, another language or no name", () => {
    expect(
      templateLaneChanges([
        update({ event: "REJECTED" }),
        update({ event: "PENDING_DELETION" }),
        update({ event: "FLAGGED" }),
        // The same name in another language is another template: we only
        // ever send pt_BR.
        update({ language: "en_US" }),
        update({ templateName: null }),
      ]),
    ).toEqual([]);

    // An older callback without the language still names our template.
    expect(templateLaneChanges([update({ language: null })])).toHaveLength(1);
  });
});

describe("the provider's pause, fed from outside a send", () => {
  it("stops calling Meta for a paused template before any send is refused", async () => {
    const provider = new MetaCloudApiProvider();
    const fetchMock = stubFetch();

    provider.pauseTemplate(TEMPLATE, 3 * 3600);

    const result = await send(provider);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, retryable: true, errorCode: 132015 });
    expect(result.retryAfterSeconds).toBeGreaterThan(3 * 3600 - 5);
  });

  it("never shortens a pause already running", async () => {
    const provider = new MetaCloudApiProvider();
    stubFetch();

    provider.pauseTemplate(TEMPLATE, 6 * 3600);
    provider.pauseTemplate(TEMPLATE, 3600);

    expect((await send(provider)).retryAfterSeconds).toBeGreaterThan(6 * 3600 - 5);
  });

  it("keeps Meta's longer pause when a send already in flight comes back refused", async () => {
    const provider = new MetaCloudApiProvider();

    // The send left before the PAUSED callback landed, and Meta refuses it
    // after: its hour must not replace the six hours Meta announced.
    let answer!: (response: Response) => void;

    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );

    const inFlight = send(provider);

    provider.pauseTemplate(TEMPLATE, 6 * 3600);

    answer(
      new Response(
        JSON.stringify({ error: { message: "Template is paused", code: 132015 } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    expect(await inFlight).toMatchObject({ retryable: true, errorCode: 132015 });

    const fetchMock = stubFetch();
    const result = await send(provider);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.retryAfterSeconds).toBeGreaterThan(6 * 3600 - 5);
  });

  it("sends again as soon as the pause is lifted, even one learned from a refusal", async () => {
    const provider = new MetaCloudApiProvider();

    stubFetch(400, { error: { message: "Template is paused", code: 132015 } });
    await send(provider);

    provider.resumeTemplate(TEMPLATE);

    const fetchMock = stubFetch();
    const result = await send(provider);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

describe("a change another replica announced", () => {
  /**
   * The callback reaches ONE replica; the others learn it through the
   * Socket.IO adapter (at-most-once, ADR 0002). What arrives there is
   * untrusted until checked: anything malformed is dropped.
   */
  let provider: MetaCloudApiProvider;

  beforeEach(() => {
    provider = new MetaCloudApiProvider();
    container.registerInstance("WhatsAppProvider", provider);
  });

  it("pauses and resumes this replica's provider", async () => {
    const fetchMock = stubFetch();

    expect(
      applyWhatsAppTemplateLaneChange({ template: TEMPLATE, action: "pause", seconds: 3600 }),
    ).toBe(true);

    await send(provider);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(applyWhatsAppTemplateLaneChange({ template: TEMPLATE, action: "resume" })).toBe(true);

    await send(provider);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops anything malformed", async () => {
    const fetchMock = stubFetch();

    for (const garbage of [
      null,
      "pause",
      { template: TEMPLATE, action: "pause" },
      { template: TEMPLATE, action: "pause", seconds: -1 },
      { template: TEMPLATE, action: "pause", seconds: Number.POSITIVE_INFINITY },
      { template: TEMPLATE, action: "pause", seconds: 10 * 24 * 3600 },
      { template: "", action: "resume" },
      { template: TEMPLATE, action: "explode" },
    ]) {
      expect(applyWhatsAppTemplateLaneChange(garbage)).toBe(false);
    }

    await send(provider);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a provider that keeps no pause", () => {
    container.registerInstance("WhatsAppProvider", {
      isConfigured: () => true,
      sendMessage: async () => ({ success: true, retryable: false, message: "ok" }),
    });

    expect(applyWhatsAppTemplateLaneChange({ template: TEMPLATE, action: "resume" })).toBe(false);
  });
});
