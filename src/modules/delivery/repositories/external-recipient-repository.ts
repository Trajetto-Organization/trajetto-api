import database from "@/../infra/database";

import { randomBytes } from "node:crypto";

import { PUBLIC_AUTHORIZATION_STATUSES } from "@/shared/delivery/public-occurrence";
import type { Prisma } from "@prisma/client";

import {
  messageOptOutOf,
  sharesSuppressionAddress,
  suppressionAddresses,
  uniqueSuppressionAddresses,
  type CustomerContact,
  type CustomerMessageChannel,
  type MessageOptOut,
} from "@/shared/notifications/customer-message-suppression";

import type {
  CustomerMessagesReactivation,
  DeliveryContactState,
  IExternalRecipientRepository,
  TrackingSource,
} from "./IExternal-recipient-repository";

import type {
  EnsureExternalRecipientProps,
  ExternalRecipientRecord,
} from "../dtos/external-recipient-dto";

class ExternalRecipientRepository implements IExternalRecipientRepository {
  constructor(private prisma = database) {}

  async ensureForDelivery(
    data: EnsureExternalRecipientProps,
  ): Promise<ExternalRecipientRecord> {
    const saved = await this.prisma.externalRecipient.upsert({
      where: { deliveryId: data.deliveryId },
      create: {
        deliveryId: data.deliveryId,
        businessId: data.businessId,
        name: data.name,
        email: data.email,
        telephone: data.telephone,

        // 32 bytes, because this is the only thing between a forwarded link
        // and somebody else's delivery.
        access_token: randomBytes(32).toString("hex"),
      },
      update: {
        // The contact details are refreshed — a customer who corrected their
        // phone after the first message must get the second one. The TOKEN is
        // not: the link already in their hand has to keep working.
        name: data.name,
        email: data.email,
        telephone: data.telephone,
      },
    });

    return saved as ExternalRecipientRecord;
  }

  async findByToken(token: string): Promise<TrackingSource | null> {
    const found = await this.prisma.externalRecipient.findUnique({
      where: { access_token: token },
      include: {
        delivery: {
          select: {
            id: true,
            code: true,
            status: true,
            invoice_number: true,
            recipient_name: true,
            city: true,
            uf: true,
            scheduled_date: true,
            delivered_at: true,
            received_by: true,
            business: {
              select: {
                corporate_reason: true,
                fantasy_name: true,
                timezone: true,
              },
            },

            // Only the moments a customer can act on. No status overrides,
            // no notes the operation wrote to itself.
            events: {
              where: { type: { in: ["ARRIVAL", "PROOF"] } },
              orderBy: { created_at: "desc" },
              select: {
                created_at: true,
                occurred_at: true,
                type: true,
                note: true,
              },
            },

            occurrences: {
              // The platform's own types ("Comprovante rejeitado", from the
              // proof audit) are the office talking to itself: they never
              // reach the person waiting for the delivery. Nor a DELIVERED
              // occurrence (decision 14.3): the delivery already shows as
              // delivered through its PROOF, and a second line would repeat it.
              // Only what happened: a request the tower has not approved is
              // not a fact about the delivery (decision 6.3).
              where: {
                occurrenceType: { is_system: false },
                category: "NOT_DELIVERED",
                authorization_status: { in: PUBLIC_AUTHORIZATION_STATUSES },
              },
              orderBy: { created_at: "desc" },
              select: {
                created_at: true,
                occurred_at: true,
                description: true,
                occurrenceType: { select: { name: true } },
              },
            },

            proofDocument: { select: { verification_token: true } },
          },
        },
      },
    });

    if (!found) return null;

    const { delivery, ...recipient } = found;

    // The visit's other NF-e (B6): the siblings of the delivery's current
    // stop, on that route, of this same company.
    const stop = await this.prisma.routeStop.findFirst({
      where: {
        deliveryId: delivery.id,
        stop_group_key: { not: null },
        route: { businessId: found.businessId },
      },
      orderBy: { created_at: "desc" },
      select: { routeId: true, stop_group_key: true },
    });

    const siblings = stop
      ? await this.prisma.routeStop.findMany({
          where: {
            routeId: stop.routeId,
            stop_group_key: stop.stop_group_key,
            deliveryId: { not: delivery.id },
            delivery: { businessId: found.businessId },
          },
          orderBy: { sequence: "asc" },
          select: {
            delivery: {
              select: {
                code: true,
                invoice_number: true,
                status: true,
                delivered_at: true,
              },
            },
          },
        })
      : [];

    return {
      recipient: recipient as unknown as ExternalRecipientRecord,

      delivery: {
        id: delivery.id,
        code: delivery.code,
        status: delivery.status,
        invoice_number: delivery.invoice_number,
        recipient_name: delivery.recipient_name,
        city: delivery.city,
        uf: delivery.uf,
        scheduled_date: delivery.scheduled_date,
        delivered_at: delivery.delivered_at,
        received_by: delivery.received_by,
        business: delivery.business,
      },

      // When it happened, for what the driver's app sent later: the person
      // waiting was told "entregue às 13:40" for a receipt signed at 10:05
      // (MOB-08). The view sorts by this, so it has to be the fact's time.
      events: delivery.events.map((event) => ({
        created_at: event.occurred_at ?? event.created_at,
        type: event.type,
        note: event.note,
      })),

      occurrences: delivery.occurrences.map((occurrence) => ({
        created_at: occurrence.occurred_at ?? occurrence.created_at,
        typeName: occurrence.occurrenceType?.name ?? "Ocorrência",
        description: occurrence.description,
      })),

      proofToken: delivery.proofDocument?.verification_token ?? null,

      sameStop: siblings.map((sibling) => sibling.delivery),
    };
  }

  async optOut(token: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // The row's businessId is the delivery's company: copied when the row
      // is created, and no record ever moves company (decision 16.100).
      const recipient = await tx.externalRecipient.findUnique({
        where: { access_token: token },
        select: {
          id: true,
          businessId: true,
          deliveryId: true,
          email: true,
          telephone: true,
        },
      });

      // A token nobody holds is a no-op, and the controller's answer is the
      // same whether the token was real.
      if (!recipient) return false;

      const { count } = await tx.externalRecipient.updateMany({
        where: { id: recipient.id, opted_out_at: null },
        data: { opted_out_at: new Date() },
      });

      // D38: the phone and the e-mail, for every delivery of this company.
      // Written even on a second click (a row opted out before this table
      // existed gets its suppression now). ON CONFLICT DO NOTHING on the
      // unique key: a repeat, or two replicas racing, inserts nothing.
      const addresses = suppressionAddresses(recipient);

      if (addresses.length > 0) {
        await tx.customerMessageSuppression.createMany({
          data: addresses.map(({ channel, address }) => ({
            businessId: recipient.businessId,
            channel,
            address,
            source_delivery_id: recipient.deliveryId,
          })),
          skipDuplicates: true,
        });
      }

      return count > 0;
    });
  }

  async suppressedChannels(
    businessId: string,
    contact: CustomerContact,
  ): Promise<Set<CustomerMessageChannel>> {
    const addresses = suppressionAddresses(contact);

    if (addresses.length === 0) return new Set();

    // Served by the (businessId, channel, address) unique index.
    const rows = await this.prisma.customerMessageSuppression.findMany({
      where: { businessId, OR: addresses },
      select: { channel: true },
    });

    return new Set(rows.map((row) => row.channel));
  }

  async findDeliveryState(
    deliveryId: string,
  ): Promise<DeliveryContactState | null> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: {
        status: true,
        recipient_name: true,
        recipient_email: true,
        recipient_telephone: true,
        externalRecipient: { select: { opted_out_at: true } },
      },
    });

    if (!delivery) return null;

    return {
      status: delivery.status,
      name: delivery.recipient_name,
      email: delivery.recipient_email,
      telephone: delivery.recipient_telephone,
      optedOut: Boolean(delivery.externalRecipient?.opted_out_at),
    };
  }

  async messageOptOutState(
    businessId: string,
    deliveryId: string,
  ): Promise<MessageOptOut | null> {
    // Scoped by company: another company's delivery reads as absent.
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, businessId },
      select: {
        recipient_telephone: true,
        recipient_email: true,
        externalRecipient: { select: { opted_out_at: true } },
      },
    });

    if (!delivery) return null;

    const contact = {
      telephone: delivery.recipient_telephone,
      email: delivery.recipient_email,
    };
    const addresses = suppressionAddresses(contact);

    // Served by the (businessId, channel, address) unique index.
    const suppressions = addresses.length
      ? await this.prisma.customerMessageSuppression.findMany({
          where: { businessId, OR: addresses },
          select: { channel: true, address: true, created_at: true },
        })
      : [];

    return messageOptOutOf(
      contact,
      suppressions,
      delivery.externalRecipient?.opted_out_at ?? null,
    );
  }

  async reactivateCustomerMessages(
    businessId: string,
    deliveryId: string,
    onReactivated?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<CustomerMessagesReactivation | null> {
    return this.prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.findFirst({
        where: { id: deliveryId, businessId },
        select: {
          recipient_telephone: true,
          recipient_email: true,
          externalRecipient: { select: { telephone: true, email: true } },
        },
      });

      if (!delivery) return null;

      // The contact messages go to now, and the one the recipient row kept
      // when the link was sent (a corrected phone leaves the old one there).
      const addresses = uniqueSuppressionAddresses([
        ...suppressionAddresses({
          telephone: delivery.recipient_telephone,
          email: delivery.recipient_email,
        }),
        ...(delivery.externalRecipient
          ? suppressionAddresses(delivery.externalRecipient)
          : []),
      ]);

      const removedSuppressions = addresses.length
        ? (
            await tx.customerMessageSuppression.deleteMany({
              where: { businessId, OR: addresses },
            })
          ).count
        : 0;

      // The company's opted-out rows, compared under the normalized key
      // (the rows keep the contact as typed). Opt-outs are rare and the read
      // stays inside one company, by its (businessId, created_at) index; it
      // runs only when somebody presses "Reativar".
      const optedOut = await tx.externalRecipient.findMany({
        where: { businessId, opted_out_at: { not: null } },
        select: { id: true, deliveryId: true, telephone: true, email: true },
      });

      const ids = optedOut
        .filter(
          (row) =>
            row.deliveryId === deliveryId ||
            sharesSuppressionAddress(row, addresses),
        )
        .map((row) => row.id);

      const clearedOptOuts = ids.length
        ? (
            await tx.externalRecipient.updateMany({
              where: {
                businessId,
                id: { in: ids },
                opted_out_at: { not: null },
              },
              data: { opted_out_at: null },
            })
          ).count
        : 0;

      if (removedSuppressions + clearedOptOuts > 0) await onReactivated?.(tx);

      return { removedSuppressions, clearedOptOuts };
    });
  }
}

export { ExternalRecipientRepository };
