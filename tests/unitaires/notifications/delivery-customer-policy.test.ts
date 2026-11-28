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
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

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

  // The delivery as it stands now: the policy addresses the contact the
  // delivery holds, not the event's copy (customer-message-freshness.test.ts).
  recipients.deliveryStates.set(DELIVERY, {
    status: "IN_TRANSIT",
    name: "Padaria Central Ltda",
    email: "contato@padaria.com.br",
    telephone: "11999999999",
  });

  businesses = new InMemoryBusinessRepository();

  businesses.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
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
    await seedTemplate("DISPATCHED", "EMAIL", "Saiu para entrega {{link}}");

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
    await seedTemplate("DISPATCHED", "EMAIL", "Saiu para entrega {{link}}");
    await seedTemplate("DELIVERED", "EMAIL", "Entregue {{link}}");

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
    recipients.deliveryStates.set(DELIVERY, {
      status: "IN_TRANSIT",
      name: "Padaria Central Ltda",
      email: null,
      telephone: null,
    });

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
  /**
   * Plan of 02/11/2026 (B2). On WhatsApp the moment goes out as a fixed
   * UTILITY template approved by Meta — the carrier's own text used to ride
   * a single parameter of a template Meta filed as Marketing. The row is the
   * switch; the carrier's name, the recipient and the NF-e are the
   * parameters; the tracking token ends both URL buttons.
   */
  it("goes out as the moment's fixed template, with the token in both buttons", async () => {
    await seedTemplate(
      "DELIVERED",
      "WHATSAPP",
      "texto antigo da empresa, que não é mais enviado",
    );

    const [recipient] =
      await deliveryDeliveredPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      );

    const rendered = await deliveryDeliveredPolicy.renderExternal!(
      payload({ deliveredAt: new Date("2026-09-17T17:30:00.000Z") }),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.whatsapp).toEqual({
      name: "trajetto_cliente_entregue",
      parameters: [
        "Padaria Central Ltda",
        "Silva Log",
        "NF-e 12345",
        "17/09/2026, 14:30",
      ],
      urlButtonSuffixes: [recipient.access_token, recipient.access_token],
    });

    // The company's old text never reaches the customer.
    expect(JSON.stringify(rendered)).not.toContain("texto antigo");
  });

  it("speaks in the company's words on the e-mail", async () => {
    await seedTemplate(
      "DELIVERED",
      "EMAIL",
      "Oi {{destinatario}}! Sua NF {{nota}} foi entregue por {{transportadora}}. Acompanhe: {{link}}",
    );

    const [recipient] =
      await deliveryDeliveredPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      );

    const rendered = await deliveryDeliveredPolicy.renderExternal!(
      payload(),
      recipient,
      deps(),
      "EMAIL",
    );

    expect(rendered!.body).toContain("Oi Padaria Central Ltda!");
    expect(rendered!.body).toContain("NF 12345");
    expect(rendered!.body).toContain("Silva Log");
    expect(rendered!.body).toContain(recipient.access_token);
    expect(rendered!.whatsapp).toBeUndefined();
  });

  it("sends nothing at all when the company never wrote that message", async () => {
    // Null is a DECISION, not a failure. A carrier that has not written the
    // "saiu para entrega" text does not want one sent in their name — and no
    // recipient means no delivery row, so the decision never shows up as a
    // dead-lettered failure in the Sistema counters (DLVP-NOTIF-2).
    const found = await deliveryDispatchedPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    expect(found).toEqual([]);
    expect(recipients.recipients).toEqual([]);

    // And a recipient reached by any other path still renders nothing.
    const recipient = await recipients.ensureForDelivery({
      deliveryId: DELIVERY,
      businessId: BUSINESS,
      name: "Padaria Central Ltda",
      email: "contato@padaria.com.br",
      telephone: "11999999999",
    });

    expect(
      await deliveryDispatchedPolicy.renderExternal!(
        payload(),
        recipient as never,
        deps(),
        "WHATSAPP",
      ),
    ).toBeNull();
  });

  it("does not use a template the company retired", async () => {
    await seedTemplate("DELIVERED", "EMAIL", "texto");

    templates.templates[0].is_active = false;

    expect(
      await deliveryDeliveredPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      ),
    ).toEqual([]);
    expect(recipients.recipients).toEqual([]);
  });

  it("keeps the channels apart", async () => {
    // An e-mail and a WhatsApp are not the same message, and a company that
    // wrote one must not have the other sent on their behalf.
    await seedTemplate("DELIVERED", "EMAIL", "corpo de e-mail");

    const [recipient] =
      await deliveryDeliveredPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      );

    // Only the channel with a template is offered, so no WhatsApp row is ever
    // created for this moment...
    expect(recipient.email).toBe("contato@padaria.com.br");
    expect(recipient.telephone).toBeNull();

    // ...while the stored contact stays whole for the next moment.
    expect(recipients.recipients[0].telephone).toBe("11999999999");

    expect(
      await deliveryDeliveredPolicy.renderExternal!(
        payload(),
        recipient,
        deps(),
        "WHATSAPP",
      ),
    ).toBeNull();
  });

  it("always carries a way to stop: the button ends in the token", async () => {
    await seedTemplate("DISPATCHED", "WHATSAPP", "");

    const [recipient] =
      await deliveryDispatchedPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      );

    const rendered = await deliveryDispatchedPolicy.renderExternal!(
      payload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.whatsapp!.name).toBe("trajetto_cliente_saiu_para_entrega");
    expect(rendered!.whatsapp!.urlButtonSuffixes).toHaveLength(2);
    expect(rendered!.whatsapp!.urlButtonSuffixes[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names the order, or says there is no number, when the delivery has no NF-e", async () => {
    await seedTemplate("DISPATCHED", "WHATSAPP", "");

    const [recipient] =
      await deliveryDispatchedPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      );

    const withOrder = await deliveryDispatchedPolicy.renderExternal!(
      payload({ invoiceNumber: null }),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(withOrder!.whatsapp!.parameters[2]).toBe("pedido PED-4471");

    const bare = await deliveryDispatchedPolicy.renderExternal!(
      payload({ invoiceNumber: null, code: null }),
      recipient,
      deps(),
      "WHATSAPP",
    );

    // Meta refuses an empty parameter: the fallback goes instead.
    expect(bare!.whatsapp!.parameters[2]).toBe("sem número informado");
  });

  it("does not escape the company's own punctuation", async () => {
    // Plain text. Escaping turns "Café & Cia" into "Café &amp; Cia" in
    // somebody's WhatsApp.
    await seedTemplate("DELIVERED", "WHATSAPP", "");

    businesses.business[0].fantasy_name = "Café & Cia";

    const [recipient] =
      await deliveryDeliveredPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      );

    const rendered = await deliveryDeliveredPolicy.renderExternal!(
      payload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.whatsapp!.parameters[1]).toBe("Café & Cia");
  });

  it("falls back to the corporate name when there is no trading name", async () => {
    await seedTemplate("DELIVERED", "WHATSAPP", "");

    businesses.business[0].fantasy_name = null;

    const [recipient] =
      await deliveryDeliveredPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      );

    const rendered = await deliveryDeliveredPolicy.renderExternal!(
      payload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.whatsapp!.parameters[1]).toBe("Transportes Silva Ltda");
  });
});

/**
 * One message per stop (plan of 02/11/2026, B6): a payload that speaks of
 * the stop's NF-e lists them all, carries one link — the lowest delivery id
 * of the stop, the same on every moment — goes on while any of them is still
 * true, and stops for everybody once the person asked any of them to.
 */
describe("a message about a whole stop", () => {
  const SIBLING = "018f0000-0000-7000-8000-0000000000e0";

  const stopPayload = (overrides: Partial<DeliveryCustomerPayload> = {}) =>
    payload({
      routeId: "018f0000-0000-7000-8000-00000000aa01",
      stopGroupKey: "grupo",
      deliveries: [
        { deliveryId: DELIVERY, invoiceNumber: "12345", code: null },
        { deliveryId: SIBLING, invoiceNumber: "12346", code: null },
      ],
      ...overrides,
    });

  beforeEach(() => {
    recipients.deliveryStates.set(SIBLING, {
      status: "IN_TRANSIT",
      name: "Padaria Central Ltda",
      email: "contato@padaria.com.br",
      telephone: "11999999999",
    });
  });

  it("lists every NF-e and carries the link of the stop's lowest delivery", async () => {
    await seedTemplate("DISPATCHED", "WHATSAPP", "");

    const [recipient] =
      await deliveryDispatchedPolicy.resolveExternalRecipients!(
        stopPayload(),
        deps(),
      );

    // SIBLING sorts before DELIVERY: its row carries the stop's link.
    expect(recipients.recipients.map((row) => row.deliveryId)).toEqual([
      SIBLING,
    ]);

    const rendered = await deliveryDispatchedPolicy.renderExternal!(
      stopPayload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.whatsapp!.parameters[2]).toBe("NF-e 12345 e 12346");
    expect(rendered!.whatsapp!.urlButtonSuffixes[0]).toBe(
      recipient.access_token,
    );
  });

  it("leaves out the NF-e the moment stopped being true of", async () => {
    await seedTemplate("DISPATCHED", "WHATSAPP", "");

    recipients.deliveryStates.set(SIBLING, {
      ...recipients.deliveryStates.get(SIBLING)!,
      status: "CANCELLED",
    });

    const [recipient] =
      await deliveryDispatchedPolicy.resolveExternalRecipients!(
        stopPayload(),
        deps(),
      );

    expect(
      await deliveryDispatchedPolicy.supersededReason!(stopPayload(), deps()),
    ).toBeNull();

    const rendered = await deliveryDispatchedPolicy.renderExternal!(
      stopPayload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.whatsapp!.parameters[2]).toBe("NF-e 12345");
  });

  it("is superseded only once every NF-e of the stop moved past it", async () => {
    for (const id of [DELIVERY, SIBLING]) {
      recipients.deliveryStates.set(id, {
        ...recipients.deliveryStates.get(id)!,
        status: "DELIVERED",
      });
    }

    expect(
      await deliveryDispatchedPolicy.supersededReason!(stopPayload(), deps()),
    ).toMatch(/superada/);
  });

  it("stops for the whole stop once the person asked any of its messages to", async () => {
    await seedTemplate("DISPATCHED", "WHATSAPP", "");

    const other = await recipients.ensureForDelivery({
      deliveryId: DELIVERY,
      businessId: BUSINESS,
      name: "Padaria Central Ltda",
      email: null,
      telephone: "11999999999",
    });

    other.opted_out_at = new Date();

    const [recipient] =
      await deliveryDispatchedPolicy.resolveExternalRecipients!(
        stopPayload(),
        deps(),
      );

    expect(recipient.opted_out_at).not.toBeNull();
  });
});

describe("dates in the message", () => {
  it("prints the expected date as the day, with no time, in any zone", async () => {
    // Decision 1.3: the column holds UTC midnight of the chosen day. On the
    // carrier's clock (UTC-3) the old formatter printed "16/09/2026, 21:00".
    await seedTemplate(
      "DISPATCHED",
      "EMAIL",
      "Previsão: {{previsao}}. Acompanhe: {{link}}",
    );

    const [recipient] =
      await deliveryDispatchedPolicy.resolveExternalRecipients!(
        payload({ scheduledDate: new Date("2026-09-17T00:00:00.000Z") }),
        deps(),
      );

    const rendered = await deliveryDispatchedPolicy.renderExternal!(
      payload({ scheduledDate: new Date("2026-09-17T00:00:00.000Z") }),
      recipient,
      deps(),
      "EMAIL",
    );

    expect(rendered!.body).toContain("Previsão: 17/09/2026.");
    expect(rendered!.body).not.toMatch(/d{2}:d{2}/);
  });

  it("prints the delivery moment on the carrier's own clock", async () => {
    // Decision 1.1: a carrier in Manaus (UTC-4) reads its own time.
    (businesses.business[0] as Business & { timezone: string }).timezone =
      "America/Manaus";

    await seedTemplate(
      "DELIVERED",
      "EMAIL",
      "Entregue em {{data_entrega}}. {{link}}",
    );

    const [recipient] =
      await deliveryDeliveredPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      );

    const rendered = await deliveryDeliveredPolicy.renderExternal!(
      payload({ deliveredAt: new Date("2026-09-17T15:30:00.000Z") }),
      recipient,
      deps(),
      "EMAIL",
    );

    expect(rendered!.body).toContain("Entregue em 17/09/2026, 11:30.");
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
