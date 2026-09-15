import database from "@/../infra/database";

import { randomBytes } from "node:crypto";

import type {
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
              select: { corporate_reason: true, fantasy_name: true },
            },

            // Only the moments a customer can act on. No status overrides,
            // no notes the operation wrote to itself.
            events: {
              where: { type: { in: ["ARRIVAL", "PROOF"] } },
              orderBy: { created_at: "desc" },
              select: { created_at: true, type: true, note: true },
            },

            occurrences: {
              orderBy: { created_at: "desc" },
              select: {
                created_at: true,
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

      events: delivery.events.map((event) => ({
        created_at: event.created_at,
        type: event.type,
        note: event.note,
      })),

      occurrences: delivery.occurrences.map((occurrence) => ({
        created_at: occurrence.created_at,
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
}

export { ExternalRecipientRepository };
