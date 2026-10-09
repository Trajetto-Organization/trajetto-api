import database from "@/../infra/database";

import { randomBytes } from "node:crypto";

import { PUBLIC_AUTHORIZATION_STATUSES } from "@/shared/delivery/public-occurrence";

import type {
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
              select: { corporate_reason: true, fantasy_name: true, timezone: true },
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
    };
  }

  async optOut(token: string): Promise<boolean> {
    // updateMany, so a token nobody holds is a no-op instead of a throw — and
    // so the answer is the same whether the token was real.
    const { count } = await this.prisma.externalRecipient.updateMany({
      where: { access_token: token, opted_out_at: null },
      data: { opted_out_at: new Date() },
    });

    return count > 0;
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
      },
    });

    if (!delivery) return null;

    return {
      status: delivery.status,
      name: delivery.recipient_name,
      email: delivery.recipient_email,
      telephone: delivery.recipient_telephone,
    };
  }
}

export { ExternalRecipientRepository };
