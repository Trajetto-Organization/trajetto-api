import database from "@/../infra/database";

import type { IProofDocumentRepository } from "./IProof-document-repository";
import type {
  ProofDocumentRecord,
  ProofDocumentSource,
  SaveProofDocumentProps,
} from "../dtos/proof-document-dto";

import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";

class ProofDocumentRepository implements IProofDocumentRepository {
  constructor(private prisma = database) {}

  async findByDelivery(
    deliveryId: string,
    businessId: string,
  ): Promise<ProofDocumentRecord | null> {
    const found = await this.prisma.deliveryProofDocument.findFirst({
      where: { deliveryId, businessId },
    });

    return found as ProofDocumentRecord | null;
  }

  async findByVerificationToken(
    token: string,
  ): Promise<(ProofDocumentRecord & { delivery: unknown }) | null> {
    const found = await this.prisma.deliveryProofDocument.findUnique({
      where: { verification_token: token },
      include: {
        delivery: {
          select: {
            recipient_name: true,
            city: true,
            uf: true,
            invoice_number: true,
            delivered_at: true,
            received_by: true,
            business: { select: { corporate_reason: true, fantasy_name: true } },
          },
        },
      },
    });

    return found as unknown as
      | (ProofDocumentRecord & { delivery: unknown })
      | null;
  }

  async loadSource(
    deliveryId: string,
    businessId: string,
  ): Promise<ProofDocumentSource | null> {
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, businessId },
      include: {
        business: {
          select: {
            corporate_reason: true,
            fantasy_name: true,
            cnpj: true,
          },
        },
        shipper: { select: { name: true, cnpj: true } },
        driver: { select: { name: true, cpf: true } },

        // The most recent proof. A delivery re-proven after a correction has
        // two, and the document describes the one that stands.
        events: {
          where: { type: "PROOF" },
          orderBy: { created_at: "desc" },
          take: 1,
          select: {
            created_at: true,
            latitude: true,
            longitude: true,
            device: true,
            photo: true,
            signature: true,
          },
        },

        occurrences: {
          orderBy: { created_at: "asc" },
          select: {
            created_at: true,
            description: true,
            occurrenceType: { select: { name: true, blocks_delivery: true } },
          },
        },

        // The stop, and through it the route number the dispatcher planned.
        stops: {
          orderBy: { created_at: "desc" },
          take: 1,
          select: { route: { select: { code: true, name: true } } },
        },
      },
    });

    if (!delivery) return null;

    const proof = delivery.events[0] ?? null;
    const route = delivery.stops[0]?.route ?? null;

    return {
      delivery: {
        id: delivery.id,
        code: delivery.code,
        status: delivery.status as DeliveryStatus,

        invoice_key: delivery.invoice_key,
        invoice_number: delivery.invoice_number,

        recipient_name: delivery.recipient_name,
        recipient_document: delivery.recipient_document,

        street: delivery.street,
        address_number: delivery.address_number,
        complement: delivery.complement,
        neighborhood: delivery.neighborhood,
        city: delivery.city,
        uf: delivery.uf,
        cep: delivery.cep,

        delivered_at: delivery.delivered_at,
        received_by: delivery.received_by,

        shipper: delivery.shipper,
      },

      business: delivery.business,
      driver: delivery.driver,

      route,

      proof: proof
        ? {
            created_at: proof.created_at,
            latitude: proof.latitude,
            longitude: proof.longitude,
            device: proof.device,
            photoKey: proof.photo,
            signatureKey: proof.signature,
          }
        : null,

      occurrences: delivery.occurrences.map((occurrence) => ({
        created_at: occurrence.created_at,
        typeName: occurrence.occurrenceType?.name ?? "Ocorrência",
        blocking: occurrence.occurrenceType?.blocks_delivery ?? false,
        description: occurrence.description,
      })),
    };
  }

  async save(data: SaveProofDocumentProps): Promise<ProofDocumentRecord> {
    const saved = await this.prisma.deliveryProofDocument.upsert({
      where: { deliveryId: data.deliveryId },
      create: {
        deliveryId: data.deliveryId,
        businessId: data.businessId,
        storage_key: data.storage_key,
        sha256: data.sha256,
        verification_token: data.verification_token,
        size_bytes: data.size_bytes,
      },
      update: {
        storage_key: data.storage_key,
        sha256: data.sha256,
        size_bytes: data.size_bytes,

        // The token survives a regeneration on purpose: a customer holding a
        // printed QR from last week must still reach the page. The version is
        // what tells them their copy is not the current one.
        version: { increment: 1 },
        generated_at: new Date(),
      },
    });

    return saved as ProofDocumentRecord;
  }
}

export { ProofDocumentRepository };
