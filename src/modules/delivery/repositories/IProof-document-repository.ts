import type {
  GpsAddressCache,
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
   * The first document of a delivery, or the one somebody else created first.
   *
   * Insert-only: when another first reader got there before, nothing is
   * written and their row comes back with `created: false`. That row's token
   * is the delivery's token from then on, and whoever lost has rendered a QR
   * with a token no row holds — they render again with this one (IDEMP-12).
   */
  createIfAbsent: (
    data: SaveProofDocumentProps,
  ) => Promise<{ record: ProofDocumentRecord; created: boolean }>;

  /**
   * Writes the row, replacing any previous one for the same delivery.
   *
   * The update branch keeps the token — a printed QR must keep working — and
   * moves storage_key and sha256 together. The key is addressed by the hash
   * (proofStorageKey), so whichever save lands last, the row describes the
   * object it points at.
   */
  save: (data: SaveProofDocumentProps) => Promise<ProofDocumentRecord>;

  /**
   * Caches the reverse-geocoded address on the proof event (design §4.2),
   * so a regeneration prints the same text and the provider is asked once.
   * Scoped by tenant: another company's event is left untouched.
   */
  saveGpsAddress: (
    eventId: string,
    businessId: string,
    cache: GpsAddressCache,
  ) => Promise<void>;
}

export type { IProofDocumentRepository };
