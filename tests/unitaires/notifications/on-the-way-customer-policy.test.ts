import { beforeEach, describe, expect, it } from "vitest";

import {
  TOPIC_BY_EVENT,
  customerMessageStillTrue,
  deliveryOnTheWayPolicy,
} from "@/shared/notifications/policies/delivery-customer-policy";
import {
  getNotificationPolicy,
  notificationPolicies,
} from "@/shared/notifications/notification-policy";

import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";
import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { DeliveryCustomerPayload } from "@/shared/notifications/notification-types";
import type { Business } from "@/modules/business/dtos/business-dto";
import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";

/**
 * The "a caminho" message (decision 6.4): the fourth moment a carrier may
 * tell the person waiting, and — like the other three — only in the
 * company's own words. A company with no active ON_THE_WAY template sends
 * nothing, even when it wrote every other moment.
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

  recipients.deliveryStates.set(DELIVERY, {
    status: "IN_TRANSIT",
    name: "Padaria Central Ltda",
    email: "contato@padaria.com.br",
    telephone: "65999999999",
  });

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

function payload(): DeliveryCustomerPayload {
  return {
    deliveryId: DELIVERY,
    businessId: BUSINESS,
    recipientName: "Padaria Central Ltda",
    recipientEmail: "contato@padaria.com.br",
    recipientTelephone: "65999999999",
    invoiceNumber: "12345",
    code: "PED-1",
    city: "Cuiabá",
    uf: "MT",
    scheduledDate: null,
    deliveredAt: null,
    receivedBy: null,
  };
}

function seed(
  topic: "DISPATCHED" | "ON_THE_WAY",
  channel: "EMAIL" | "WHATSAPP",
  is_active = true,
) {
  return templates.save({
    businessId: BUSINESS,
    topic,
    channel,
    subject: null,
    body:
      topic === "ON_THE_WAY"
        ? "{{destinatario}}, o motorista da {{transportadora}} está a caminho. {{link}} Sair: {{link_descadastro}}"
        : "Sua entrega saiu. {{link}} Sair: {{link_descadastro}}",
    is_active,
  });
}

describe("the ON_THE_WAY topic", () => {
  it("is the policy of the delivery.on_the_way outbox topic", () => {
    expect(TOPIC_BY_EVENT["delivery.on_the_way"]).toBe("ON_THE_WAY");
    expect(notificationPolicies["delivery.on_the_way"]).toBe(
      deliveryOnTheWayPolicy,
    );
    expect(getNotificationPolicy("delivery.on_the_way")).toBe(
      deliveryOnTheWayPolicy,
    );
  });

  it("notifies nobody inside the company", async () => {
    expect(
      await deliveryOnTheWayPolicy.resolveRecipients(payload(), deps()),
    ).toEqual([]);
  });
});

describe("whether anybody is told", () => {
  it("nobody without an active ON_THE_WAY template, even with the other moments written", async () => {
    await seed("DISPATCHED", "WHATSAPP");
    await seed("DISPATCHED", "EMAIL");
    await seed("ON_THE_WAY", "WHATSAPP", false);

    expect(
      await deliveryOnTheWayPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      ),
    ).toEqual([]);

    // Decided before any row exists: nothing to count as a failure later.
    expect(recipients.recipients).toEqual([]);
  });

  it("the person, on the channel that has an active template", async () => {
    await seed("ON_THE_WAY", "WHATSAPP");

    const [recipient] = await deliveryOnTheWayPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    expect(recipient.telephone).toBe("65999999999");
    expect(recipient.email).toBeNull();
  });
});

describe("what it says", () => {
  it("renders the company's ON_THE_WAY template with the way out", async () => {
    await seed("ON_THE_WAY", "WHATSAPP");

    const [recipient] = await deliveryOnTheWayPolicy.resolveExternalRecipients!(
      payload(),
      deps(),
    );

    const rendered = await deliveryOnTheWayPolicy.renderExternal!(
      payload(),
      recipient,
      deps(),
      "WHATSAPP",
    );

    expect(rendered!.body).toContain(
      "Padaria Central Ltda, o motorista da Silva Log está a caminho.",
    );
    expect(rendered!.body).toContain(recipient.access_token);
  });
});

describe("when it stops being true", () => {
  it("only while the load is on the street", () => {
    expect(customerMessageStillTrue("ON_THE_WAY", "IN_TRANSIT")).toBe(true);

    for (const status of ["PENDING", "DELIVERED", "FAILED", "CANCELLED"]) {
      expect(customerMessageStillTrue("ON_THE_WAY", status), status).toBe(
        false,
      );
    }
  });

  it("names the reason when the delivery moved past it before the send", async () => {
    recipients.deliveryStates.set(DELIVERY, {
      status: "DELIVERED",
      name: "Padaria Central Ltda",
      email: null,
      telephone: "65999999999",
    });

    expect(
      await deliveryOnTheWayPolicy.supersededReason!(payload(), deps()),
    ).toMatch(/ON_THE_WAY superada: a entrega está DELIVERED/);
  });
});
