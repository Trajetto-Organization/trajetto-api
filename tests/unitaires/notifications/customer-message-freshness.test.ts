import { beforeEach, describe, expect, it } from "vitest";

import {
  customerMessageStillTrue,
  deliveryDeliveredPolicy,
  deliveryDispatchedPolicy,
  deliveryFailedPolicy,
} from "@/shared/notifications/policies/delivery-customer-policy";

import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";
import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";

import type { DeliveryCustomerPayload } from "@/shared/notifications/notification-types";
import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";

/**
 * A customer message is sent only while it is still true.
 *
 * The three messages ("saiu", "entregue", "não entregue") are three events,
 * each delivered and retried on its own — up to 30 minutes of backoff apart.
 * A "saiu para entrega" held back by a Meta hiccup went out AFTER the
 * "entregue" that followed it ten minutes later (GAP2-5). And the contact a
 * message goes to was the one in the EVENT: a late or re-run expansion of an
 * old event wrote an outdated phone back over the corrected one (OUTBOX-21).
 * The delivery row is the truth for both.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DELIVERY = "018f0000-0000-7000-8000-0000000000e1";

let recipients: InMemoryExternalRecipientRepository;

beforeEach(() => {
  recipients = new InMemoryExternalRecipientRepository();
});

function deps() {
  return {
    userRepository: {} as unknown as IUserRepository,
    externalRecipientRepository: recipients,
    messageTemplateRepository: new InMemoryDeliveryMessageTemplateRepository(),
    businessRepository: new InMemoryBusinessRepository(),
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
    recipientTelephone: "5511900000000",
    invoiceNumber: null,
    code: null,
    city: "São Paulo",
    uf: "SP",
    scheduledDate: null,
    deliveredAt: null,
    receivedBy: null,
    ...overrides,
  };
}

function stateOf(
  status: string,
  contact: { email?: string | null; telephone?: string | null } = {},
) {
  recipients.deliveryStates.set(DELIVERY, {
    status,
    name: "Padaria Central Ltda",
    email: contact.email ?? null,
    telephone:
      contact.telephone === undefined ? "5511900000000" : contact.telephone,
  });
}

describe("whether a customer message is still true", () => {
  it.each([
    ["DISPATCHED", "IN_TRANSIT", true],
    // "Saiu" is only ever published for a delivery its departure moved to
    // IN_TRANSIT. PENDING after that is the load back in the pool — the route
    // ended with the stop open, or the dispatcher moved it back.
    ["DISPATCHED", "PENDING", false],
    ["DISPATCHED", "DELIVERED", false],
    ["DISPATCHED", "FAILED", false],
    ["DISPATCHED", "CANCELLED", false],
    ["DELIVERED", "DELIVERED", true],
    ["DELIVERED", "FAILED", false],
    ["DELIVERED", "IN_TRANSIT", false],
    ["FAILED", "FAILED", true],
    ["FAILED", "PENDING", true],
    ["FAILED", "IN_TRANSIT", false],
    ["FAILED", "DELIVERED", false],
  ] as const)("%s while the delivery is %s: %s", (topic, status, expected) => {
    expect(customerMessageStillTrue(topic, status)).toBe(expected);
  });
});

describe("a message the delivery has moved past", () => {
  it("is superseded: 'saiu para entrega' once it was delivered", async () => {
    stateOf("DELIVERED");

    const reason = await deliveryDispatchedPolicy.supersededReason!(
      payload(),
      deps(),
    );

    expect(reason).toMatch(/superada/);
    expect(reason).toContain("DELIVERED");
  });

  it("is superseded: 'saiu para entrega' once the load came back to the pool", async () => {
    // The route was cancelled after departure with this stop still open, and
    // its delivery went back to PENDING while the "saiu" sat in backoff.
    stateOf("PENDING");

    expect(
      await deliveryDispatchedPolicy.supersededReason!(payload(), deps()),
    ).toMatch(/superada: a entrega está PENDING/);
  });

  it("is superseded: 'entregue' once the status was overridden to failed", async () => {
    stateOf("FAILED");

    expect(
      await deliveryDeliveredPolicy.supersededReason!(payload(), deps()),
    ).toMatch(/superada/);
  });

  it("is still sent while it is true", async () => {
    stateOf("IN_TRANSIT");

    expect(
      await deliveryDispatchedPolicy.supersededReason!(payload(), deps()),
    ).toBeNull();

    stateOf("FAILED");

    expect(
      await deliveryFailedPolicy.supersededReason!(payload(), deps()),
    ).toBeNull();
  });

  it("is dropped when the delivery no longer exists", async () => {
    expect(
      await deliveryDispatchedPolicy.supersededReason!(payload(), deps()),
    ).toMatch(/não existe mais/);
  });
});

describe("who a customer message goes to", () => {
  it("is the contact the delivery holds now, not the one in the event", async () => {
    // The event carries the phone as it was at dispatch; the dispatcher
    // corrected it since. A re-run of the old event must not undo that.
    stateOf("IN_TRANSIT", { telephone: "5511911110000" });

    // A WhatsApp "saiu para entrega" the company wrote: without one, nobody
    // is addressed at all (DLVP-NOTIF-2).
    const withTemplate = deps();

    await withTemplate.messageTemplateRepository.save({
      businessId: BUSINESS,
      topic: "DISPATCHED",
      channel: "WHATSAPP",
      subject: null,
      body: "Saiu! {{link}} Sair: {{link_descadastro}}",
      is_active: true,
    });

    const [recipient] =
      await deliveryDispatchedPolicy.resolveExternalRecipients!(
        payload({ recipientTelephone: "5511900000000" }),
        withTemplate,
      );

    expect(recipient.telephone).toBe("5511911110000");
    expect(recipients.recipients[0].telephone).toBe("5511911110000");
  });

  it("is nobody once the delivery holds no contact", async () => {
    stateOf("IN_TRANSIT", { email: null, telephone: null });

    expect(
      await deliveryDispatchedPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      ),
    ).toEqual([]);
  });

  it("is nobody when the delivery was deleted", async () => {
    expect(
      await deliveryDispatchedPolicy.resolveExternalRecipients!(
        payload(),
        deps(),
      ),
    ).toEqual([]);
    expect(recipients.recipients).toEqual([]);
  });
});
