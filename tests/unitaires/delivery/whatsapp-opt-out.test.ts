import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/env";

import { deliveryDispatchedPolicy } from "@/shared/notifications/policies/delivery-customer-policy";
import { fitWhatsAppBody } from "@/shared/delivery/whatsapp-body";

import { MetaCloudApiProvider } from "@/shared/providers/whatsapp-provider/implementations/meta-cloud-api-provider";
import { SaveMessageTemplateUseCase } from "@/modules/delivery/usecases/save-message-template/save-message-template-usecase";

import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";
import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { Business } from "@/modules/business/dtos/business-dto";
import type { User } from "@/modules/user/dtos/user-dto";
import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { DeliveryCustomerPayload } from "@/shared/notifications/notification-types";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

/**
 * The way out of a carrier's WhatsApp to its customer.
 *
 * The body is capped at 900 characters by the provider, and the cap used to
 * cut the END of the text — which is where the opt-out link sits in every
 * suggested template. A long, perfectly valid template went out without
 * '/parar', from the one number every tenant shares.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DELIVERY = "018f0000-0000-7000-8000-0000000000e1";
const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";

/**
 * A legitimate company text of about 670 characters, links excluded: the
 * templates below stay under the form's 900-character limit (~800-820).
 */
const LONG_TEXT = Array.from(
  { length: 12 },
  (_, index) =>
    `Parágrafo ${index + 1}: sua encomenda segue os cuidados de sempre.`,
).join(" ");

const savedHttp = env.HTTP_REQUEST;

let recipients: InMemoryExternalRecipientRepository;
let templates: InMemoryDeliveryMessageTemplateRepository;
let businesses: InMemoryBusinessRepository;

beforeEach(() => {
  // Production's base URL: the links' real length is what the cap meets.
  env.HTTP_REQUEST = "https://www.intrajetto.com";

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
});

afterEach(() => {
  env.HTTP_REQUEST = savedHttp;
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

function payload(): DeliveryCustomerPayload {
  return {
    deliveryId: DELIVERY,
    businessId: BUSINESS,
    recipientName: "Padaria Central Ltda",
    recipientEmail: null,
    recipientTelephone: "11999999999",
    invoiceNumber: "12345",
    code: "PED-4471",
    city: "São Paulo",
    uf: "SP",
    scheduledDate: null,
    deliveredAt: null,
    receivedBy: null,
  };
}

async function renderWhatsApp(body: string) {
  await templates.save({
    businessId: BUSINESS,
    topic: "DISPATCHED",
    channel: "WHATSAPP",
    subject: null,
    body,
    is_active: true,
  });

  const [recipient] = await deliveryDispatchedPolicy.resolveExternalRecipients!(
    payload(),
    deps(),
  );

  const rendered = await deliveryDispatchedPolicy.renderExternal!(
    payload(),
    recipient,
    deps(),
    "WHATSAPP",
  );

  return { rendered: rendered!, recipient };
}

describe("a long WhatsApp to a customer", () => {
  it("still carries the opt-out link when the text is cut", async () => {
    const { rendered, recipient } = await renderWhatsApp(
      `Olá {{destinatario}}! ${LONG_TEXT} Acompanhe: {{link}} ${LONG_TEXT.slice(0, 60)} Para não receber mais: {{link_descadastro}}`,
    );

    expect(rendered.body.length).toBeLessThanOrEqual(900);
    expect(rendered.body).toContain(
      `/acompanhar/${recipient.access_token}/parar`,
    );
  });

  it("reaches Meta with the link, not cut off by the provider", async () => {
    const { rendered } = await renderWhatsApp(
      `Olá {{destinatario}}! ${LONG_TEXT} Acompanhe: {{link}} ${LONG_TEXT.slice(0, 60)} Para não receber mais: {{link_descadastro}}`,
    );

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), {
          status: 200,
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const token = env.META_WHATSAPP_ACCESS_TOKEN;
    const phone = env.META_WHATSAPP_PHONE_NUMBER_ID;

    env.META_WHATSAPP_ACCESS_TOKEN = "token-de-teste";
    env.META_WHATSAPP_PHONE_NUMBER_ID = "1234567890";

    try {
      await new MetaCloudApiProvider().sendMessage({
        phoneNumber: "11999999999",
        message: rendered.body,
      });
    } finally {
      env.META_WHATSAPP_ACCESS_TOKEN = token;
      env.META_WHATSAPP_PHONE_NUMBER_ID = phone;
    }

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];

    const sent = JSON.parse(init.body).template.components[0].parameters[0]
      .text as string;

    expect(sent).toContain("/parar");
    expect(sent.endsWith("…")).toBe(false);
  });

  it("leaves a message that fits exactly as the company wrote it", async () => {
    const { rendered } = await renderWhatsApp(
      "Saiu para entrega. Sair da lista: {{link_descadastro}}",
    );

    expect(rendered.body).toMatch(
      /^Saiu para entrega\. Sair da lista: https:\/\/www\.intrajetto\.com\/acompanhar\/[0-9a-f]{64}\/parar$/,
    );
  });

  it("adds the way out to a stored template that lacks it", async () => {
    // Saved by a path that skipped the use case's check: the rule holds at
    // the boundary, not only in the form.
    const { rendered, recipient } = await renderWhatsApp("Saiu para entrega.");

    expect(rendered.body).toContain(`${recipient.access_token}/parar`);
  });
});

describe("fitWhatsAppBody", () => {
  const LINK = `https://www.intrajetto.com/acompanhar/${"a".repeat(64)}/parar`;

  it("passes a short text through, flattened like the provider does", () => {
    expect(fitWhatsAppBody(`Olá\n\nsaiu.   Sair: ${LINK}`, LINK)).toBe(
      `Olá saiu. Sair: ${LINK}`,
    );
  });

  it("never returns more than the cap, and always the link", () => {
    for (const length of [0, 100, 850, 899, 900, 901, 2_000]) {
      const text = `${"x ".repeat(length / 2)}${LINK}`;
      const fitted = fitWhatsAppBody(text, LINK);

      expect(fitted.length, `length ${length}`).toBeLessThanOrEqual(900);
      expect(fitted, `length ${length}`).toContain(LINK);
    }
  });

  it("cuts at a word boundary", () => {
    const fitted = fitWhatsAppBody(`${"palavra ".repeat(200)}${LINK}`, LINK);

    expect(fitted).toMatch(/palavra… /);
  });
});

describe("saving a WhatsApp template", () => {
  let useCase: SaveMessageTemplateUseCase;

  beforeEach(() => {
    const users = new InMemoryUserRepository();

    users.user.push({
      id: DISPATCHER,
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    } as User);

    useCase = new SaveMessageTemplateUseCase(users, templates);
  });

  function save(channel: "WHATSAPP" | "EMAIL", body: string) {
    return useCase.execute({
      userId: DISPATCHER,
      businessId: BUSINESS,
      topic: "DISPATCHED",
      channel,
      subject: channel === "EMAIL" ? "Saiu" : null,
      body,
      is_active: true,
    } as Parameters<SaveMessageTemplateUseCase["execute"]>[0]);
  }

  it("refuses one that would not fit once the links are in", async () => {
    // The form counted 900 characters of TEMPLATE; each link then grows by a
    // hundred. The company learns it here, not from a customer's cut message.
    await expect(
      save(
        "WHATSAPP",
        `${LONG_TEXT} {{link}} ${LONG_TEXT.slice(0, 80)} Sair: {{link_descadastro}}`,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "WHATSAPP_TEMPLATE_TOO_LONG",
    });
  });

  it("accepts the same text by e-mail, which has no such cap", async () => {
    await expect(
      save(
        "EMAIL",
        `${LONG_TEXT} {{link}} ${LONG_TEXT.slice(0, 80)} Sair: {{link_descadastro}}`,
      ),
    ).resolves.toBeDefined();
  });

  it("accepts an ordinary WhatsApp template", async () => {
    await expect(
      save(
        "WHATSAPP",
        "Olá {{destinatario}}, sua entrega saiu. {{link}} Sair: {{link_descadastro}}",
      ),
    ).resolves.toBeDefined();
  });
});
