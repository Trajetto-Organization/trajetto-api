import type {
  ProofDocumentRecord,
  ProofDocumentSource,
  SaveProofDocumentProps,
} from "../dtos/proof-document-dto";

/**
 * The receipt a delivery leaves behind.
 *
 * Generated LAZILY — on the first request for it, not on every proof. Most
 * deliveries never have their PDF opened, and rendering five million documents
 * a month so that two percent are read is work nobody asked for. The row is
 * written once and the bytes are reused from then on, which is also what makes
 * the stored hash meaningful: it describes a specific file that exists.
 */
interface IProofDocumentRepository {
  findByDelivery: (
    deliveryId: string,
    businessId: string,
  ) => Promise<ProofDocumentRecord | null>;

  /** The public page's only way in. Not scoped by tenant — the token is. */
  findByVerificationToken: (
    token: string,
  ) => Promise<(ProofDocumentRecord & { delivery: unknown }) | null>;

  /**
   * Everything the document prints, in one read.
   *
   * One query rather than five because a proof pulls from the delivery, the
   * business, the driver, the route and the events — and a document assembled
   * from five reads taken milliseconds apart can describe a state that never
   * existed at any single moment.
   */
  loadSource: (
    deliveryId: string,
    businessId: string,
  ) => Promise<ProofDocumentSource | null>;

  /**
   * Writes the row, replacing any previous one for the same delivery.
   *
   * Upsert and not create: two concurrent first-readers both render, and the
   * second must not fail with a unique violation on a request that did nothing
   * wrong. The storage key is derived from the delivery, so both wrote the same
   * object and there is nothing orphaned either way.
   */
  save: (data: SaveProofDocumentProps) => Promise<ProofDocumentRecord>;
}

export type { IProofDocumentRepository };
