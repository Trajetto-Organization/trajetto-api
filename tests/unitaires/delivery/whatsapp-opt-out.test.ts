import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";

import { deliveryDispatchedPolicy } from "@/shared/notifications/policies/delivery-customer-policy";
import { CUSTOMER_WHATSAPP_TEMPLATES } from "@/shared/delivery/customer-whatsapp-templates";

import { MetaCloudApiProvider } from "@/shared/providers/whatsapp-provider/implementations/meta-cloud-api-provider";

import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";
import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import type { Business } from "@/modules/business/dtos/business-dto";
import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { DeliveryCustomerPayload } from "@/shared/notifications/notification-types";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

/**
 * The way out of a carrier's WhatsApp to its customer.
 *
 * It used to be a link inside the company's free text, which the provider's
 * 900-character cut could take off the end. Plan of 02/11/2026 (B2): every
 * customer message is a fixed template approved by Meta with a "Parar de
 * receber" URL button, whose only variable — the end of the URL — is the
 * tracking token; nothing can cut it off. And Meta refuses an empty
 * parameter, so none ever goes empty.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DELIVERY = "018f0000-0000-7000-8000-0000000000e1";

const saved = {
  token: env.META_WHATSAPP_ACCESS_TOKEN,
  phone: env.META_WHATSAPP_PHONE_NUMBER_ID,
};

let recipients: InMemoryExternalRecipientRepository;
let templates: InMemoryDeliveryMessageTemplateRepository;
let businesses: InMemoryBusinessRepository;

beforeEach(async () => {
  recipients = new InMemoryExternalRecipientRepository();
  templates = new InMemoryDeliveryMessageTemplateRepository();
  businesses = new InMemoryBusinessRepository();

  recipients.deliveryStates.set(DELIVERY, {
    status: "IN_TRANSIT",
    name: "Padaria Central Ltda",
    email: null,
    telephone: "11999999999",
  });

  businesses.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
    corporate_reason: "Transportes Silva Ltda",
    fantasy_name: "Silva Log",
  } as Business);

  // The WhatsApp row is only the moment's switch (B3).
  await templates.save({
    businessId: BUSINESS,
    topic: "DISPATCHED",
    channel: "WHATSAPP",
    subject: null,
    body: "",
    is_active: true,
  });
});

afterEach(() => {
  env.META_WHATSAPP_ACCESS_TOKEN = saved.token;
  env.META_WHATSAPP_PHONE_NUMBER_ID = saved.phone;

  vi.unstubAllGlobals();
});

function deps() {
  return {
    userRepository: {} as unknown as IUserRepository,
    externalRecipientRepository: recipients,
    messageTemplateRepository: templates,
    businessRepository: businesses,
  };
}

function payload(
  overrides: Partial<DeliveryCustomerPayload> = {},
): DeliveryCustomerPayload {
  return {
    deliveryId: DELIVERY,
    businessId: BUSINESS,
    recipientName: "Padaria Central Ltda",
    recipientEmail: null,
    recipientTelephone: "11999999999",
    invoiceNumber: "12345",
    code: null,
    city: "São Paulo",
    uf: "SP",
    scheduledDate: null,
    deliveredAt: null,
    receivedBy: null,
    ...overrides,
  };
}

async function render(data: DeliveryCustomerPayload = payload()) {
  const [recipient] = await deliveryDispatchedPolicy.resolveExternalRecipients!(
    data,
    deps(),
  );

  const rendered = await deliveryDispatchedPolicy.renderExternal!(
    data,
    recipient,
    deps(),
    "WHATSAPP",
  );

  return { recipient, rendered: rendered! };
}

describe("the way out of a customer WhatsApp", () => {
  it("is a button of the approved template, ending in the tracking token", () => {
    // The URL's fixed part is approved at Meta; the token is all we send.
    expect(
      Object.values(CUSTOMER_WHATSAPP_TEMPLATES).map((template) =>
        template.buttons.map((button) => [button.text, button.path]),
      ),
    ).toEqual(
      Array(4).fill([
        ["Acompanhar entrega", "acompanhar/{{1}}"],
        ["Parar de receber", "parar/{{1}}"],
      ]),
    );
  });

  it("reaches Meta with the token at the end of both buttons", async () => {
    env.META_WHATSAPP_ACCESS_TOKEN = "token-de-teste";
    env.META_WHATSAPP_PHONE_NUMBER_ID = "1234567890";

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const { recipient, rendered } = await render();

    await new MetaCloudApiProvider().sendMessage({
      phoneNumber: "11999999999",
      template: rendered.whatsapp!,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];

    const buttons = (
      JSON.parse(init.body) as {
        template: {
          components: Array<{
            type: string;
            index?: string;
            parameters: Array<{ text: string }>;
          }>;
        };
      }
    ).template.components.filter((component) => component.type === "button");

    expect(buttons.map((button) => button.index)).toEqual(["0", "1"]);

    for (const button of buttons) {
      expect(button.parameters).toEqual([
        { type: "text", text: recipient.access_token },
      ]);
    }
  });
});

describe("the parameters of a customer WhatsApp", () => {
  it("are never empty, whatever the delivery lacks", async () => {
    recipients.deliveryStates.set(DELIVERY, {
      status: "IN_TRANSIT",
      name: "   ",
      email: null,
      telephone: "11999999999",
    });

    businesses.business[0].fantasy_name = null;
    businesses.business[0].corporate_reason = "";

    const { rendered } = await render(
      payload({ recipientName: " ", invoiceNumber: null, code: null }),
    );

    expect(rendered.whatsapp!.parameters).toHaveLength(3);

    for (const parameter of rendered.whatsapp!.parameters) {
      expect(parameter.trim().length).toBeGreaterThan(0);
    }
  });

  it("go on one line and are cut with an ellipsis past their limit", async () => {
    businesses.business[0].fantasy_name = `Transportes\n${"Muito ".repeat(30)}Longos`;

    const { rendered } = await render();

    const carrier = rendered.whatsapp!.parameters[1];

    expect(carrier).not.toContain("\n");
    expect(carrier.length).toBeLessThanOrEqual(60);
    expect(carrier.endsWith("…")).toBe(true);
  });
});
