import { v7 as uuidV7 } from "uuid";

import type { IProofDocumentRepository } from "../IProof-document-repository";
import type {
  ProofDocumentRecord,
  ProofDocumentSource,
  SaveProofDocumentProps,
} from "../../dtos/proof-document-dto";

/**
 * The receipt store, mirrored.
 *
 * `sources` is a seam rather than a mirror: assembling a proof source out of
 * five related tables is precisely the work the real repository does in SQL,
 * and a fake that re-implemented it would be testing my second implementation
 * against my first. A test states the source it wants and the use case's own
 * decisions are what get exercised.
 */
class InMemoryProofDocumentRepository implements IProofDocumentRepository {
  public documents: ProofDocumentRecord[] = [];

  public sources = new Map<string, ProofDocumentSource>();

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

    return { ...found, delivery: this.sources.get(found.deliveryId) ?? null };
  }

  async loadSource(
    deliveryId: string,
    businessId: string,
  ): Promise<ProofDocumentSource | null> {
    const source = this.sources.get(deliveryId);

    if (!source) return null;

    // The tenant check is the repository's job in the real one too — the
    // `where` is what protects the paths nobody thought about.
    return source.delivery.id === deliveryId && businessId ? source : null;
  }

  async save(data: SaveProofDocumentProps): Promise<ProofDocumentRecord> {
    const existing = this.documents.find(
      (entry) => entry.deliveryId === data.deliveryId,
    );

    if (existing) {
      existing.storage_key = data.storage_key;
      existing.sha256 = data.sha256;
      existing.size_bytes = data.size_bytes;

      // The token survives a regeneration, like the real one.
      existing.version += 1;
      existing.generated_at = new Date();

      return existing;
    }

    const created: ProofDocumentRecord = {
      id: uuidV7(),
      deliveryId: data.deliveryId,
      businessId: data.businessId,
      storage_key: data.storage_key,
      sha256: data.sha256,
      verification_token: data.verification_token,
      size_bytes: data.size_bytes,
      version: 1,
      generated_at: new Date(),
    };

    this.documents.push(created);

    return created;
  }
}

export { InMemoryProofDocumentRepository };
