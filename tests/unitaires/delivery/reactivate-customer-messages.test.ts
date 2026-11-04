import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { ReactivateCustomerMessagesUseCase } from "@/modules/delivery/usecases/reactivate-customer-messages/reactivate-customer-messages-usecase";
import { messageOptOutOf } from "@/shared/notifications/customer-message-suppression";

import type { User } from "@/modules/user/dtos/user-dto";
import type { NotificationService } from "@/shared/services/notification-service";

/**
 * Undoing "Parar de receber" from the delivery (contract C2 of 03/11/2026).
 *
 * The opt-out by phone and e-mail inside the carrier (D38) had no undo in
 * the product: a customer who clicked by mistake, or changed their mind,
 * needed support to delete a row. The dispatcher now sees the state on the
 * delivery's detail and reactivates it there: the company's suppressions of
 * that recipient's phone and e-mail go, every opted-out recipient row of the
 * company with the same contact is cleared, and the activity records who
 * did it. Idempotent; never another company's rows; never a driver.
 */
const CARRIER = "018fb700-0000-7000-8000-00000000000a";
const OTHER = "018fb700-0000-7000-8000-00000000000b";

const DISPATCHER = "018fb700-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018fb700-0000-7000-8000-0000000000a2";
const OTHER_ADMIN = "018fb700-0000-7000-8000-0000000000a3";

const CLICKED = "018fb700-0000-7000-8000-0000000000d1";
const NEXT = "018fb700-0000-7000-8000-0000000000d2";
const STRANGER = "018fb700-0000-7000-8000-0000000000d3";
const FOREIGN = "018fb700-0000-7000-8000-0000000000d9";

const CONTACT = { telephone: "(11) 98888-1001", email: "Maria@Exemplo.com.br" };

function world() {
  const recipients = new InMemoryExternalRecipientRepository();
  const users = new InMemoryUserRepository();
  const activity = vi.fn(async (_entry: Record<string, unknown>) => undefined);

  users.user.push(
    { id: DISPATCHER, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: "018fb700-0000-7000-8000-0000000000e1",
    } as User,
    { id: OTHER_ADMIN, role: "BUSINESS_ADMIN", businessId: OTHER } as User,
  );

  const deliveries: Array<[string, string, typeof CONTACT]> = [
    [CLICKED, CARRIER, CONTACT],
    // The same person, typed another way on the next NF-e.
    [
      NEXT,
      CARRIER,
      { telephone: "11988881001", email: " maria@exemplo.com.br" },
    ],
    [STRANGER, CARRIER, { telephone: "(21) 97777-2002", email: "joao@ex.com" }],
    // Another carrier writing to the same person.
    [FOREIGN, OTHER, CONTACT],
  ];

  for (const [id, businessId, contact] of deliveries) {
    recipients.deliveryCompanies.set(id, businessId);
    recipients.deliveryStates.set(id, {
      status: "IN_TRANSIT",
      name: "Maria Souza",
      ...contact,
    });
  }

  const useCase = new ReactivateCustomerMessagesUseCase(users, recipients, {
    createActivityIfEnabled: activity,
  } as unknown as NotificationService);

  return { recipients, useCase, activity };
}

async function optOut(
  recipients: InMemoryExternalRecipientRepository,
  deliveryId: string,
  businessId: string,
  contact: typeof CONTACT,
): Promise<void> {
  const row = await recipients.ensureForDelivery({
    deliveryId,
    businessId,
    name: "Maria Souza",
    ...contact,
  });

  await recipients.optOut(row.access_token);
}

describe("the opt-out state on the delivery's detail", () => {
  it("is the date of the suppression of the delivery's phone and e-mail, null while receiving", async () => {
    const { recipients } = world();

    expect(await recipients.messageOptOutState(CARRIER, NEXT)).toEqual({
      whatsapp: null,
      email: null,
    });

    await optOut(recipients, CLICKED, CARRIER, CONTACT);

    const state = await recipients.messageOptOutState(CARRIER, NEXT);

    expect(state?.whatsapp).toBeInstanceOf(Date);
    expect(state?.email).toBeInstanceOf(Date);
    // Another recipient of the company keeps receiving.
    expect(await recipients.messageOptOutState(CARRIER, STRANGER)).toEqual({
      whatsapp: null,
      email: null,
    });
    // And a delivery of another company is not this company's to read.
    expect(await recipients.messageOptOutState(CARRIER, FOREIGN)).toBeNull();
  });

  it("falls back to the delivery's own opt-out for a row from before the suppressions", () => {
    const at = new Date("2026-10-01T12:00:00.000Z");

    expect(messageOptOutOf(CONTACT, [], at)).toEqual({
      whatsapp: at,
      email: at,
    });
    // Without a phone there is nothing to stop on WhatsApp.
    expect(
      messageOptOutOf({ telephone: null, email: "a@b.com" }, [], at),
    ).toEqual({ whatsapp: null, email: at });
  });
});

describe("reactivating the customer's messages from a delivery", () => {
  it("removes the company's suppressions of that phone and e-mail and clears every opted-out row with the same contact", async () => {
    const { recipients, useCase, activity } = world();

    await optOut(recipients, CLICKED, CARRIER, CONTACT);
    await optOut(recipients, FOREIGN, OTHER, CONTACT);

    // From the delivery that was NOT clicked: the same person.
    const answer = await useCase.execute({
      userId: DISPATCHER,
      businessId: CARRIER,
      deliveryId: NEXT,
    });

    expect(answer).toEqual({ messageOptOut: { whatsapp: null, email: null } });
    expect(
      recipients.suppressions.filter((row) => row.businessId === CARRIER),
    ).toEqual([]);
    expect(
      recipients.recipients.find((row) => row.deliveryId === CLICKED)
        ?.opted_out_at,
    ).toBeNull();
    expect(await recipients.suppressedChannels(CARRIER, CONTACT)).toEqual(
      new Set(),
    );

    // Another carrier's opt-out stays.
    expect(
      [...(await recipients.suppressedChannels(OTHER, CONTACT))].sort(),
    ).toEqual(["EMAIL", "WHATSAPP"]);
    expect(
      recipients.recipients.find((row) => row.deliveryId === FOREIGN)
        ?.opted_out_at,
    ).toBeInstanceOf(Date);

    expect(activity).toHaveBeenCalledOnce();
    expect(activity.mock.calls[0][0]).toMatchObject({
      type: "Entrega",
      action: "update",
      entityId: NEXT,
      description: "Mensagens ao cliente reativadas",
      performedBy: DISPATCHER,
      businessId: CARRIER,
    });
  });

  it("answers the same a second time, with nothing to undo and no second activity", async () => {
    const { recipients, useCase, activity } = world();

    await optOut(recipients, CLICKED, CARRIER, CONTACT);

    const request = {
      userId: DISPATCHER,
      businessId: CARRIER,
      deliveryId: CLICKED,
    };

    const first = await useCase.execute(request);
    const second = await useCase.execute(request);

    expect(second).toEqual(first);
    expect(activity).toHaveBeenCalledOnce();
  });

  it("answers another company's delivery like a missing one, and changes nothing", async () => {
    const { recipients, useCase } = world();

    await optOut(recipients, FOREIGN, OTHER, CONTACT);

    await expect(
      useCase.execute({
        userId: DISPATCHER,
        businessId: CARRIER,
        deliveryId: FOREIGN,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "DELIVERY_NOT_FOUND" });

    // Naming the other company in the path is the tenant guard's refusal.
    await expect(
      useCase.execute({
        userId: OTHER_ADMIN,
        businessId: CARRIER,
        deliveryId: CLICKED,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(
      recipients.suppressions.filter((row) => row.businessId === OTHER),
    ).toHaveLength(2);
  });

  it("is the dispatcher's, never the driver's", async () => {
    const { recipients, useCase } = world();

    await optOut(recipients, CLICKED, CARRIER, CONTACT);

    await expect(
      useCase.execute({
        userId: DRIVER_USER,
        businessId: CARRIER,
        deliveryId: CLICKED,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVER_CANNOT_MANAGE_DELIVERIES",
    });
    expect(recipients.suppressions).toHaveLength(2);
  });
});
