import type {
  GpsAddress,
  ProofDocumentSource,
} from "@/shared/delivery/proof-document";

type ProofSignatureStatus = "SIGNED" | "UNSIGNED";

type ProofUnsignedReason =
  | "LEGACY"
  | "NO_CERTIFICATE"
  | "CERTIFICATE_EXPIRED"
  | "CERTIFICATE_INVALID"
  | "SIGNING_DISABLED";

type ProofSignatureProfile = "PADES_AD_RB" | "CMS_DETACHED";

/**
 * The signature columns (decision 14.8). Written on every save: a row left
 * UNSIGNED with no reason reads as "nobody knows why", which is the one
 * thing an unsigned legal document must never say.
 */
interface ProofSignatureColumns {
  /** 1 = before decision 14.8; 2 = the validated model. */
  layout_version: number;

  signature_status: ProofSignatureStatus;
  unsigned_reason: ProofUnsignedReason | null;
  signature_profile: ProofSignatureProfile | null;

  signer_name: string | null;
  signer_cnpj: string | null;
  cert_serial: string | null;
  cert_issuer: string | null;
  cert_not_after: Date | string | null;
  signed_at: Date | string | null;
  /**
   * Whether the signer's chain verified up to an official ICP-Brasil root
   * when the file was signed. Null when unsigned, and on documents signed
   * before the chain was checked (the issuer's name was all that was read).
   */
  cert_icp_brasil?: boolean | null;
}

interface ProofDocumentRecord extends ProofSignatureColumns {
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

interface SaveProofDocumentProps extends ProofSignatureColumns {
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

  /**
   * The carrier's zone (IANA), the one the PDF prints its moments in: the
   * page shows the same clock, so the two never disagree about a time.
   */
  timeZone: string;

  /**
   * Whether the stored file carries an ICP-Brasil signature, and whose.
   * Narrow on purpose (ADR 0009): no serial, no CNPJ — the PDF has them.
   */
  signature: {
    status: ProofSignatureStatus;
    profile: ProofSignatureProfile | null;
    signerName: string | null;
    certNotAfter: Date | string | null;
    signedAt: Date | string | null;
    /** True only when the chain reached an official ICP-Brasil root. */
    icpBrasil: boolean | null;
  };
}

/** The proof event's cached reverse-geocoded address (design §4.2). */
interface GpsAddressCache {
  gps_address: GpsAddress | null;
  gps_address_source: "PROVIDER" | "UNAVAILABLE";
  gps_geocoded_at: Date;
}

export type {
  GpsAddressCache,
  ProofDocumentRecord,
  ProofSignatureColumns,
  ProofSignatureProfile,
  ProofSignatureStatus,
  ProofUnsignedReason,
  ProofDocumentSource,
  PublicProofSummary,
  SaveProofDocumentProps,
};
