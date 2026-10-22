import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import type { IProofDocumentRepository } from "./IProof-document-repository";
import type {
  GpsAddressCache,
  ProofDocumentRecord,
  ProofDocumentSource,
  ProofSignatureColumns,
  SaveProofDocumentProps,
} from "../dtos/proof-document-dto";

import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import type { GpsAddress } from "@/shared/delivery/proof-document";
import { PUBLIC_AUTHORIZATION_STATUSES } from "@/shared/delivery/public-occurrence";

/** The layout and signature columns, written by every save (decision 14.8). */
function signatureColumns(data: ProofSignatureColumns) {
  return {
    layout_version: data.layout_version,
    signature_status: data.signature_status,
    unsigned_reason: data.unsigned_reason,
    signature_profile: data.signature_profile,
    signer_name: data.signer_name,
    signer_cnpj: data.signer_cnpj,
    cert_serial: data.cert_serial,
    cert_issuer: data.cert_issuer,
    cert_not_after: data.cert_not_after ? new Date(data.cert_not_after) : null,
    signed_at: data.signed_at ? new Date(data.signed_at) : null,
  };
}

/** The cached address JSON back as the model's shape; anything else is null. */
function asGpsAddress(value: unknown): GpsAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const field = (name: string) => {
    const entry = (value as Record<string, unknown>)[name];
    return typeof entry === "string" && entry.trim() ? entry : null;
  };

  return {
    line: field("line"),
    district: field("district"),
    city: field("city"),
    state: field("state"),
    cep: field("cep"),
  };
}

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
            // The zone the page prints the moments in, the same as the PDF.
            business: {
              select: {
                corporate_reason: true,
                fantasy_name: true,
                timezone: true,
              },
            },
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
            // The receipt's moments are printed on the company's clock
            // (decision 1.1), and labelled with it.
            timezone: true,
          },
        },
        // The issuer's legal name when known (decision 14.8): the model
        // prints "Razão Social Emitente", and `name` may be a trade name.
        shipper: { select: { name: true, cnpj: true, corporate_reason: true } },
        // `id` alongside the name: without it there was nothing to compare,
        // and the check for "is the driver OF THIS delivery" degenerated into
        // "the delivery HAS a driver" — which every assigned one does.
        driver: { select: { id: true, name: true, cpf: true } },

        // The most recent proof. A delivery re-proven after a correction has
        // two, and the document describes the one that stands.
        events: {
          where: { type: "PROOF" },
          orderBy: { created_at: "desc" },
          take: 1,
          select: {
            id: true,
            created_at: true,
            occurred_at: true,
            latitude: true,
            longitude: true,
            device: true,
            device_id: true,
            photo_taken_at: true,
            photo: true,
            signature: true,
            gps_address: true,
            gps_address_source: true,
            gps_geocoded_at: true,
            // The route the proof settled (design §3 #4), before the stop's.
            route: { select: { code: true, name: true } },
            // The "delivered" occurrence recorded with it (decision 14.3):
            // its type is what "Ocorrência" prints, e.g. "Entrega normal".
            occurrence: {
              select: {
                category: true,
                occurrenceType: { select: { name: true } },
              },
            },
          },
        },

        // By arrival here; the model orders them by the moment it prints
        // (occurred_at ?? created_at), which SQL cannot sort on without a
        // COALESCE Prisma does not express. A delivery has a handful.
        //
        // Problems only (NOT_DELIVERED): with decision 14.3 every proof also
        // writes a DELIVERED occurrence, and pause reasons are occurrence
        // types too; neither is something that went wrong with the delivery.
        //
        // And only what happened: the PDF opens from the public verification,
        // so a request the tower has not approved stays out (decision 6.3).
        occurrences: {
          where: {
            category: "NOT_DELIVERED",
            authorization_status: { in: PUBLIC_AUTHORIZATION_STATUSES },
          },
          orderBy: [{ created_at: "asc" }, { id: "asc" }],
          select: {
            created_at: true,
            occurred_at: true,
            description: true,
            latitude: true,
            longitude: true,
            photos: true,
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

    // A FAILED delivery set from the panel has no blocking occurrence and a
    // null delivered_at: the status change is what says when and why. A
    // second query because `events` is already narrowed to the PROOF.
    const failure =
      delivery.status === "FAILED"
        ? await this.prisma.deliveryEvent.findFirst({
            where: {
              deliveryId,
              businessId,
              type: "STATUS_CHANGE",
              status_to: "FAILED",
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            select: {
              created_at: true,
              occurred_at: true,
              occurrenceId: true,
              reason: { select: { name: true } },
            },
          })
        : null;

    const proof = delivery.events[0] ?? null;
    const route = proof?.route ?? delivery.stops[0]?.route ?? null;

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

      // The moment printed on the receipt is the moment it was signed, for a
      // proof the driver's app sent later (MOB-08), not the upload's.
      proof: proof
        ? {
            eventId: proof.id,
            created_at: proof.occurred_at ?? proof.created_at,
            photo_taken_at: proof.photo_taken_at,
            latitude: proof.latitude,
            longitude: proof.longitude,
            device: proof.device,
            device_id: proof.device_id,
            photoKey: proof.photo,
            signatureKey: proof.signature,
            gps_address: asGpsAddress(proof.gps_address),
            gps_address_source: proof.gps_address_source,
            gps_geocoded_at: proof.gps_geocoded_at,
          }
        : null,

      deliveredTypeName:
        proof?.occurrence?.category === "DELIVERED"
          ? (proof.occurrence.occurrenceType?.name ?? null)
          : null,

      failure: failure
        ? {
            occurred_at: failure.occurred_at ?? failure.created_at,
            reasonName: failure.reason?.name ?? null,
            occurrenceId: failure.occurrenceId,
          }
        : null,

      occurrences: delivery.occurrences.map((occurrence) => ({
        created_at: occurrence.occurred_at ?? occurrence.created_at,
        typeName: occurrence.occurrenceType?.name ?? "Ocorrência",
        blocking: occurrence.occurrenceType?.blocks_delivery ?? false,
        description: occurrence.description,
        latitude: occurrence.latitude,
        longitude: occurrence.longitude,
        photoKey: occurrence.photos[0] ?? null,
      })),
    };
  }

  async createIfAbsent(
    data: SaveProofDocumentProps,
  ): Promise<{ record: ProofDocumentRecord; created: boolean }> {
    try {
      const created = await this.prisma.deliveryProofDocument.create({
        data: {
          deliveryId: data.deliveryId,
          businessId: data.businessId,
          storage_key: data.storage_key,
          sha256: data.sha256,
          verification_token: data.verification_token,
          size_bytes: data.size_bytes,
          ...signatureColumns(data),
        },
      });

      return { record: created as ProofDocumentRecord, created: true };
    } catch (error) {
      // Another first reader created it: theirs stands, untouched.
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }

      const existing = await this.prisma.deliveryProofDocument.findFirst({
        where: { deliveryId: data.deliveryId, businessId: data.businessId },
      });

      if (!existing) throw error;

      return { record: existing as ProofDocumentRecord, created: false };
    }
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
        ...signatureColumns(data),
      },
      update: {
        storage_key: data.storage_key,
        sha256: data.sha256,
        size_bytes: data.size_bytes,

        // The new bytes' layout and signature replace the old ones whole:
        // a re-signed regeneration must not keep the previous signer, and an
        // unsigned one must not keep a previous "SIGNED".
        ...signatureColumns(data),

        // The token survives a regeneration on purpose: a customer holding a
        // printed QR from last week must still reach the page. The version is
        // what tells them their copy is not the current one.
        version: { increment: 1 },
        generated_at: new Date(),
      },
    });

    return saved as ProofDocumentRecord;
  }

  async saveGpsAddress(
    eventId: string,
    businessId: string,
    cache: GpsAddressCache,
  ): Promise<void> {
    // Scoped by tenant like every write: the event id came from a source
    // already filtered by businessId, and this keeps it that way.
    await this.prisma.deliveryEvent.updateMany({
      where: { id: eventId, businessId, type: "PROOF" },
      data: {
        gps_address: cache.gps_address
          ? (cache.gps_address as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        gps_address_source: cache.gps_address_source,
        gps_geocoded_at: cache.gps_geocoded_at,
      },
    });
  }
}

export { ProofDocumentRepository };
