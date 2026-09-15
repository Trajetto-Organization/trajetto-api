import type { ProofDocumentSource } from "@/shared/delivery/proof-document";

interface ProofDocumentRecord {
  id: string;

  deliveryId: string;

  storage_key: string;
  sha256: string;

  verification_token: string;

  size_bytes: number;
  version: number;

  generated_at: Date | string;

  businessId: string;
}

interface SaveProofDocumentProps {
  deliveryId: string;
  businessId: string;

  storage_key: string;
  sha256: string;
  verification_token: string;
  size_bytes: number;
}

/**
 * Everything the public page shows about a delivery, without showing the
 * delivery.
 *
 * Deliberately narrow: this is served to anybody holding the token, so it
 * carries what confirms the receipt is genuine and nothing that would turn a
 * leaked link into a window on the operation. No shipper, no route, no driver
 * document, no other stop.
 */
interface PublicProofSummary {
  recipientName: string;
  city: string;
  uf: string;

  invoiceNumber: string | null;

  carrierName: string;

  deliveredAt: Date | string | null;
  receivedBy: string | null;

  sha256: string;
  generatedAt: Date | string;
  version: number;
}

export type {
  ProofDocumentRecord,
  ProofDocumentSource,
  PublicProofSummary,
  SaveProofDocumentProps,
};
