import { v7 as uuidV7 } from "uuid";
import { DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import { DEFAULT_BUSINESS_TIMEZONE } from "@/shared/time/business-day";

import type { IProofDocumentRepository } from "../IProof-document-repository";
import type {
  GpsAddressCache,
  ProofDocumentRecord,
  ProofDocumentSource,
  ProofSignatureColumns,
  SaveProofDocumentProps,
} from "../../dtos/proof-document-dto";

/** The columns every save writes, as the real repository's signatureColumns. */
function signatureColumns(data: ProofSignatureColumns): ProofSignatureColumns {
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

/**
 * The receipt store, mirrored.
 *
 * `sources` is a seam rather than a mirror: assembling a proof source out of
 * five related tables is precisely the work the real repository does in SQL,
 * and a fake that re-implemented it would be testing my second implementation
 * against my first. A test states the source it wants and the use case's own
 * decisions are what get exercised.
 *
 * Each source carries the company that owns the delivery (its `businessId`
 * column): the real `loadSource` filters on it, and a seam without an owner
 * handed company A's receipt to company B where Postgres answers nothing.
 */
class InMemoryProofDocumentRepository implements IProofDocumentRepository {
  public documents: ProofDocumentRecord[] = [];

  /** Keyed by delivery id, like the `delivery` table. */
  public sources = new Map<
    string,
    { businessId: string; source: ProofDocumentSource }
  >();

  /** States the delivery `source` describes, owned by `businessId`. */
  addSource(businessId: string, source: ProofDocumentSource): void {
    this.sources.set(source.delivery.id, { businessId, source });
  }

  async findByDelivery(
    deliveryId: string,
    businessId: string,
  ): Promise<ProofDocumentRecord | null> {
    return (
      this.documents.find(
        (entry) =>
          entry.deliveryId === deliveryId && entry.businessId === businessId,
      ) ?? null
    );
  }

  async findByVerificationToken(
    token: string,
  ): Promise<(ProofDocumentRecord & { delivery: unknown }) | null> {
    const found = this.documents.find(
      (entry) => entry.verification_token === token,
    );

    if (!found) return null;

    // Joined through the document, not the tenant: the token is the key.
    const source = this.sources.get(found.deliveryId)?.source;

    // The same shape as the real `select`: the delivery's own columns with
    // its business nested, not the whole document source.
    return {
      ...found,
      delivery: source
        ? {
            recipient_name: source.delivery.recipient_name,
            city: source.delivery.city,
            uf: source.delivery.uf,
            invoice_number: source.delivery.invoice_number,
            delivered_at: source.delivery.delivered_at,
            received_by: source.delivery.received_by,
            business: {
              corporate_reason: source.business.corporate_reason,
              fantasy_name: source.business.fantasy_name ?? null,
              // NOT NULL with a default in the table.
              timezone: source.business.timezone ?? DEFAULT_BUSINESS_TIMEZONE,
            },
          }
        : null,
    };
  }

  async loadSource(
    deliveryId: string,
    businessId: string,
  ): Promise<ProofDocumentSource | null> {
    const stored = this.sources.get(deliveryId);

    // `where: { id, businessId }`, as in the real one: another company's
    // delivery is as absent as one that does not exist.
    if (!stored || stored.businessId !== businessId) return null;

    return stored.source;
  }

  async createIfAbsent(
    data: SaveProofDocumentProps,
  ): Promise<{ record: ProofDocumentRecord; created: boolean }> {
    const existing = this.documents.find(
      (entry) => entry.deliveryId === data.deliveryId,
    );

    // The real one re-reads the winner with the businessId in the `where`
    // after the unique violation, and rethrows when it is not there.
    if (existing && existing.businessId !== data.businessId) {
      throw new Error(
        "Unique constraint failed on the fields: (`deliveryId`)",
      );
    }

    // Insert-only, like the real one: the first creator's row stands.
    if (existing) return { record: existing, created: false };

    return { record: await this.save(data), created: true };
  }

  async save(data: SaveProofDocumentProps): Promise<ProofDocumentRecord> {
    const existing = this.documents.find(
      (entry) => entry.deliveryId === data.deliveryId,
    );

    if (existing) {
      existing.storage_key = data.storage_key;
      existing.sha256 = data.sha256;
      existing.size_bytes = data.size_bytes;

      // Replaced whole, like the real upsert's update branch.
      Object.assign(existing, signatureColumns(data));

      // The token survives a regeneration, like the real one.
      existing.version += 1;
      existing.generated_at = new Date();

      return existing;
    }

    const created: ProofDocumentRecord = {
      // Layout and signature columns as Postgres writes them (decision 14.8).
      ...DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS,
      id: uuidV7(),
      deliveryId: data.deliveryId,
      businessId: data.businessId,
      storage_key: data.storage_key,
      sha256: data.sha256,
      verification_token: data.verification_token,
      size_bytes: data.size_bytes,
      ...signatureColumns(data),
      version: 1,
      generated_at: new Date(),
    };

    this.documents.push(created);

    return created;
  }

  async saveGpsAddress(
    eventId: string,
    businessId: string,
    cache: GpsAddressCache,
  ): Promise<void> {
    // `updateMany where { id, businessId, type: PROOF }`: only the owning
    // company's proof event, and silently nothing otherwise.
    for (const { businessId: owner, source } of this.sources.values()) {
      if (owner !== businessId || source.proof?.eventId !== eventId) continue;

      source.proof.gps_address = cache.gps_address;
      source.proof.gps_address_source = cache.gps_address_source;
      source.proof.gps_geocoded_at = cache.gps_geocoded_at;
    }
  }
}

export { InMemoryProofDocumentRepository };
