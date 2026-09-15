import { beforeEach, describe, expect, it } from "vitest";

import {
  deliveryDeliveredPolicy,
  deliveryDispatchedPolicy,
} from "@/shared/notifications/policies/delivery-customer-policy";

import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";
import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";

import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import {
  TEMPLATE_VARIABLES,
  unknownTemplateVariables,
} from "@/shared/delivery/message-template";

import type { DeliveryCustomerPayload } from "@/shared/notifications/notification-types";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";

/**
 * What a carrier says to the person waiting for their delivery.
 *
 * Two things are being protected here and they pull in opposite directions.
 * The message has to actually go out, or the feature is decoration. And it has
 * to go out in the COMPANY'S words, to somebody who can stop it with one
 * click — because a message a stranger did not ask for, in a voice that is not
 * the carrier's, is how a product gets a business reported to Meta.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DELIVERY = "018f0000-0000-7000-8000-0000000000e1";

let recipients: InMemoryExternalRecipientRepository;
let templates: InMemoryDeliveryMessageTemplateRepository;
let businesses: InMemoryBusinessRepository;

beforeEach(() => {
  recipients = new InMemoryExternalRecipientRepository();
  templates = new InMemoryDeliveryMessageTemplateRepository();

  businesses = new InMemoryBusinessRepository();

  businesses.business.push({
    id: BUSINESS,
    corporate_reason: "Transportes Silva Ltda",
    fantasy_name: "Silva Log",
  } as Business);
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
    recipientEmail: "contato@padaria.com.br",
    recipientTelephone: "11999999999",

    invoiceNumber: "12345",
    code: "PED-4471",

    city: "São Paulo",
    uf: "SP",

    scheduledDate: new Date("2026-09-16T12:00:00.000Z"),
    deliveredAt: null,
    receivedBy: null,

    ...overrides,
  };
}

function seedTemplate(
  topic: "DISPATCHED" | "DELIVERED" | "FAILED",
  channel: string,
  body: string,
  subject: string | null = null,
) {
  return templates.save({
    businessId: BUSINESS,
    topic,
    channel,
    subject,
    body,
    is_active: true,
  });
}

describe("who hears about a delivery", () => {
  it("creates the recipient row and returns them", async () => {
    const found = await deliveryDispatchedPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    expect(found).toHaveLength(1);
    expect(found[0].access_token).toMatch(/^[0-9a-f]{64}$/);

    expect(recipients.recipients).toHaveLength(1);
  });

  it("reuses the same row — and the same link — on the next moment", async () => {
    // A second row would mean a second token, and the link the customer
    // already opened would go dark halfway through their delivery.
    const [first] = await deliveryDispatchedPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    const [second] = await deliveryDeliveredPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    expect(second.access_token).toBe(first.access_token);
    expect(recipients.recipients).toHaveLength(1);
  });

  it("tells nobody when the carrier holds no contact details", async () => {
    // The ordinary case, not an error: most deliveries carry neither.
    const found = await deliveryDispatchedPolicy.resolveExternalRecipients!(
      payload({ recipientEmail: null, recipientTelephone: null }),
      deps(),
    );

    expect(found).toEqual([]);
    expect(recipients.recipients).toEqual([]);
  });

  it("notifies nobody inside the company", async () => {
    // The dispatcher's board already shows every one of these the moment it
    // happens. A bell for each would be sixty a day at thirty drivers.
    expect(
      await deliveryDispatchedPolicy.resolveRecipients(payload(), deps()),
    ).toEqual([]);
  });
});

describe("what the message says", () => {
  it("speaks in the company's words, not ours", async () => {
    await seedTemplate(
      "DELIVERED",
      "WHATSAPP",
      "Oi {{destinatario}}! Sua NF {{nota}} foi entregue por {{transportadora}}. Acompanhe: {{link}}",
    );

    const [recipient] = await deliveryDeliveredPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    const rendered = await deliveryDeliveredPolicy.renderExternal!(
      payload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered).not.toBeNull();

    expect(rendered!.body).toContain("Oi Padaria Central Ltda!");
    expect(rendered!.body).toContain("NF 12345");

    expect(rendered!.body).toContain("Silva Log");
    expect(rendered!.body).toContain(recipient.access_token);
  });

  it("sends nothing at all when the company never wrote that message", async () => {
    // Null is a DECISION, not a failure. A carrier that has not written the
    // "saiu para entrega" text does not want one sent in their name.
    const [recipient] = await deliveryDispatchedPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    expect(
      await deliveryDispatchedPolicy.renderExternal!(
        payload(),
        recipient,
        deps(),
        "WHATSAPP",
      ),
    ).toBeNull();
  });

  it("does not use a template the company retired", async () => {
    await seedTemplate("DELIVERED", "EMAIL", "texto");

    templates.templates[0].is_active = false;

    const [recipient] = await deliveryDeliveredPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    expect(
      await deliveryDeliveredPolicy.renderExternal!(
        payload(),
        recipient,
        deps(),
        "EMAIL",
      ),
    ).toBeNull();
  });

  it("keeps the channels apart", async () => {
    // An e-mail and a WhatsApp are not the same message, and a company that
    // wrote one must not have the other sent on their behalf.
    await seedTemplate("DELIVERED", "EMAIL", "corpo de e-mail");

    const [recipient] = await deliveryDeliveredPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    expect(
      await deliveryDeliveredPolicy.renderExternal!(
        payload(),
        recipient,
        deps(),
        "WHATSAPP",
      ),
    ).toBeNull();
  });

  it("always carries a way to stop", async () => {
    await seedTemplate(
      "DELIVERED",
      "WHATSAPP",
      "Entregue. Para não receber mais: {{link_descadastro}}",
    );

    const [recipient] = await deliveryDeliveredPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    const rendered = await deliveryDeliveredPolicy.renderExternal!(
      payload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.body).toContain("/parar");
  });

  it("does not escape the company's own punctuation", async () => {
    // These are plain-text messages. Escaping turns "Café & Cia" into
    // "Café &amp; Cia" in somebody's WhatsApp.
    await seedTemplate("DELIVERED", "WHATSAPP", "{{transportadora}} & você");

    businesses.business[0].fantasy_name = "Café & Cia";

    const [recipient] = await deliveryDeliveredPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    const rendered = await deliveryDeliveredPolicy.renderExternal!(
      payload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.body).toBe("Café & Cia & você");
  });

  it("falls back to the corporate name when there is no trading name", async () => {
    await seedTemplate("DELIVERED", "WHATSAPP", "{{transportadora}}");

    businesses.business[0].fantasy_name = null;

    const [recipient] = await deliveryDeliveredPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    const rendered = await deliveryDeliveredPolicy.renderExternal!(
      payload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.body).toBe("Transportes Silva Ltda");
  });
});

describe("the variables a company may use", () => {
  it("accepts every name the editor publishes", () => {
    const template = TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(" ");

    expect(unknownTemplateVariables(template)).toEqual([]);
  });

  it("names a variable that does not exist, so the form can refuse it", () => {
    // A dispatcher who typed {{motorista}} must find out in the form, not by a
    // customer receiving a message with a blank in it.
    expect(
      unknownTemplateVariables("Olá {{destinatario}}, o {{motorista}} saiu"),
    ).toEqual(["motorista"]);
  });

  it("refuses the driver's details in particular", () => {
    // The nearest thing to a leak this template language could produce.
    expect(unknownTemplateVariables("{{telefone_motorista}}")).toEqual([
      "telefone_motorista",
    ]);
  });
});
