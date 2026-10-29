import { SignPdf } from "@signpdf/signpdf";
import {
  SUBFILTER_ADOBE_PKCS7_DETACHED,
  SUBFILTER_ETSI_CADES_DETACHED,
} from "@signpdf/utils";
import { instanceCachingFactory, registry } from "tsyringe";

import fs from "node:fs";

import { env } from "@/env";
import type { ProofSigningIntent } from "@/shared/delivery/proof-document";
import { logger } from "@/shared/logging/logger";

import type { SignaturePlaceholder } from "../proof-pdf-service";
import { ProofCmsSigner, type SignatureProfile } from "./cms-signer";
import {
  certificateWindowState,
  loadSigningCertificate,
  type CertificateState,
  type LoadedCertificate,
} from "./signing-certificate";
import { isIcpBrasilAt, type IcpTrustStore } from "./icp-brasil-chain";

const log = logger.child({ component: "proof-signing" });

/**
 * Bytes reserved in /Contents for the CMS. The model's CMS is 2.5 KB with
 * one certificate; a 3-certificate chain stays well under 8 KB. 16 KB also
 * leaves room for an RFC 3161 timestamp (AD-RT) later.
 *
 * Still missing, knowingly: that timestamp. AD-RT needs a timestamp from an
 * ICP-Brasil accredited TSA (a paid service); until then the signing time
 * is the server's claim (the /M of the signature dictionary), which is what
 * AD-RB is.
 */
const SIGNATURE_LENGTH = 16_384;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The certificate's public summary, for health and alerts. */
interface ProofSigningHealth {
  state: CertificateState["state"];
  reason: string | null;
  profile: SignatureProfile | null;
  signer_name: string | null;
  not_after: string | null;
  days_left: number | null;
}

type UnsignedReason =
  | "NO_CERTIFICATE"
  | "CERTIFICATE_EXPIRED"
  | "CERTIFICATE_INVALID"
  | "SIGNING_DISABLED";

interface ProofSigningConfig {
  /** The PFX bytes, or a function that reads them (a mounted secret file). */
  pfx: Buffer | null | (() => Buffer | null);
  password: string | undefined;
  profile: SignatureProfile;
  disabled: boolean;
  location: string;
  contact: string;

  /** Bytes reserved for the CMS; SIGNATURE_LENGTH unless a test shrinks it. */
  signatureLength?: number;

  /**
   * The roots the certificate's chain must reach for the document to claim
   * ICP-Brasil validity: the official AC Raiz v5/v10/v11 unless a test
   * brings its own (icp-brasil-chain.ts).
   */
  trustStore?: IcpTrustStore;
}

/** What one document will be: decided before it is drawn. */
type SigningPlan =
  | {
      status: "SIGNED";
      intent: ProofSigningIntent;
      placeholder: SignaturePlaceholder;
      profile: SignatureProfile;
      certificate: LoadedCertificate;
    }
  | {
      status: "UNSIGNED";
      intent: ProofSigningIntent;
      placeholder: null;
      reason: UnsignedReason;
    };

/** The signature columns of DeliveryProofDocument for one document. */
interface SignatureRecord {
  signature_status: "SIGNED" | "UNSIGNED";
  unsigned_reason: UnsignedReason | null;
  signature_profile: SignatureProfile | null;
  signer_name: string | null;
  signer_cnpj: string | null;
  cert_serial: string | null;
  cert_issuer: string | null;
  cert_not_after: Date | null;
  signed_at: Date | null;
  /** True only when the chain reached an official ICP-Brasil root. */
  cert_icp_brasil: boolean | null;
}

type ProofSigningEnv = Pick<
  typeof env,
  | "PROOF_SIGNING_PFX_BASE64"
  | "PROOF_SIGNING_PFX_PATH"
  | "PROOF_SIGNING_PFX_PASSWORD"
  | "PROOF_SIGNATURE_PROFILE"
  | "PROOF_SIGNING_DISABLED"
  | "PROOF_SIGNER_LOCATION"
  | "PROOF_SIGNER_CONTACT"
>;

function configFromEnv(source: ProofSigningEnv = env): ProofSigningConfig {
  return {
    pfx: () => {
      if (source.PROOF_SIGNING_PFX_BASE64) {
        return Buffer.from(source.PROOF_SIGNING_PFX_BASE64, "base64");
      }

      // A read failure is thrown on purpose: state() turns it into
      // PFX_FILE_UNREADABLE and logs its errno, so a missing mount is told
      // apart from a wrong password.
      if (source.PROOF_SIGNING_PFX_PATH)
        return fs.readFileSync(source.PROOF_SIGNING_PFX_PATH);

      return null;
    },
    password: source.PROOF_SIGNING_PFX_PASSWORD,
    profile:
      source.PROOF_SIGNATURE_PROFILE === "cms" ? "CMS_DETACHED" : "PADES_AD_RB",
    disabled: source.PROOF_SIGNING_DISABLED,
    location: source.PROOF_SIGNER_LOCATION,
    contact: source.PROOF_SIGNER_CONTACT,
  };
}

/**
 * The platform's signature on proof documents (decision 14.8).
 *
 * The certificate is opened once per process and kept as a state; whether it
 * has expired is re-read on every document, because a process outlives the
 * day the A1 certificate lapses. The key never leaves this thread: the
 * render worker only reserves the placeholder, and the CMS is computed here
 * (one SHA-256 and one native RSA operation — a few milliseconds).
 *
 * Registered under "ProofSigningService"; tests register their own instance
 * with a certificate they generate.
 */
@registry([
  {
    token: "ProofSigningService",
    useFactory: instanceCachingFactory(() => new ProofSigningService()),
  },
])
class ProofSigningService {
  private loaded: CertificateState | null = null;

  /** The chain warning is said once per process, not once per receipt. */
  private chainWarningLogged = false;

  constructor(private readonly config: ProofSigningConfig = configFromEnv()) {}

  /**
   * The certificate state now. The PFX is opened once; its validity window
   * is re-read on every call, so READY turns EXPIRED and a certificate
   * installed ahead of its notBefore turns READY without a restart.
   */
  state(now: Date = new Date()): CertificateState {
    if (!this.loaded) {
      this.loaded = this.open(now);

      if (this.loaded.state === "INVALID" && !this.loaded.certificate) {
        // The reason code only: never the file, the password or the subject.
        log.error(
          { reason: this.loaded.reason },
          "proof signing certificate is invalid; proofs go out unsigned",
        );
      }
    }

    const current = this.loaded;

    if ("certificate" in current && current.certificate) {
      return certificateWindowState(current.certificate, now);
    }

    return current;
  }

  /**
   * Reads and parses the PFX. Never throws: every caller (boot, a request,
   * the health probe) gets a state, and a broken secret means unsigned
   * documents, not a 500.
   */
  private open(now: Date): CertificateState {
    let pfx: Buffer | null;

    try {
      pfx =
        typeof this.config.pfx === "function"
          ? this.config.pfx()
          : this.config.pfx;
    } catch (error) {
      // The errno only (ENOENT, EACCES...): a message could carry the path.
      log.error(
        {
          code: (error as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN",
        },
        "proof signing certificate file could not be read",
      );

      return { state: "INVALID", reason: "PFX_FILE_UNREADABLE" };
    }

    return loadSigningCertificate(
      {
        pfx,
        password: this.config.password,
        disabled: this.config.disabled,
        trustStore: this.config.trustStore,
      },
      now,
    );
  }

  /**
   * Whether a document signed now may claim ICP-Brasil validity, logging
   * once when it may not (a certificate outside the chain, or a chain that
   * lapsed while the process ran). The reason code only: never the subject,
   * the serial or the CNPJ.
   */
  private icpBrasilAt(certificate: LoadedCertificate, now: Date): boolean {
    const icp = isIcpBrasilAt(certificate.icpBrasil, now);

    if (!icp && !this.chainWarningLogged) {
      this.chainWarningLogged = true;

      log.warn(
        {
          event: "proof_signing_not_icp_brasil",
          reason: certificate.icpBrasil.valid
            ? "OUTSIDE_VALIDITY"
            : certificate.icpBrasil.reason,
        },
        "proof signing certificate does not chain to an ICP-Brasil root; proofs are signed without the legal-validity statement",
      );
    }

    return icp;
  }

  /**
   * Opens the certificate at boot (design §6.3) and logs its state, so a bad
   * PFX or password shows up in the deploy logs instead of on the first
   * receipt someone opens. Never throws: a broken certificate means
   * unsigned documents, not a down API.
   */
  warmUp(now: Date = new Date()): CertificateState {
    const current = this.state(now);

    const certificate =
      "certificate" in current ? current.certificate : undefined;

    // Dates and state only: no serial, subject, CNPJ or password.
    log.info(
      {
        state: current.state,
        reason: current.state === "INVALID" ? current.reason : undefined,
        notBefore: certificate?.notBefore.toISOString(),
        notAfter: certificate?.notAfter.toISOString(),
        icpBrasil: certificate
          ? isIcpBrasilAt(certificate.icpBrasil, now)
          : undefined,
      },
      "proof signing certificate state",
    );

    // At boot, so the deploy log says it before the first receipt does.
    if (current.state === "READY") this.icpBrasilAt(current.certificate, now);

    return current;
  }

  /**
   * The certificate as /health/metrics and the ops heartbeat show it
   * (design §6.3/§7.4): state, reason, profile, signer name and end date.
   * Never the serial, the CNPJ, the password or anything of the key.
   */
  health(now: Date = new Date()): ProofSigningHealth {
    const current = this.state(now);
    const certificate =
      "certificate" in current ? current.certificate : undefined;
    const notAfter = certificate?.notAfter ?? null;

    return {
      state: current.state,
      reason: current.state === "INVALID" ? current.reason : null,
      profile: certificate ? this.config.profile : null,
      signer_name: certificate?.signerName ?? null,
      not_after: notAfter?.toISOString() ?? null,
      days_left:
        notAfter === null
          ? null
          : Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS),
    };
  }

  /** Whether a document generated now would be signed. */
  available(now: Date = new Date()): boolean {
    return this.state(now).state === "READY";
  }

  plan(now: Date = new Date()): SigningPlan {
    const state = this.state(now);

    if (state.state !== "READY") {
      const reason: UnsignedReason =
        state.state === "ABSENT"
          ? "NO_CERTIFICATE"
          : state.state === "EXPIRED"
            ? "CERTIFICATE_EXPIRED"
            : state.state === "DISABLED"
              ? "SIGNING_DISABLED"
              : "CERTIFICATE_INVALID";

      return {
        status: "UNSIGNED",
        intent: { status: "UNSIGNED" },
        placeholder: null,
        reason,
      };
    }

    const { certificate } = state;

    const icpBrasil = this.icpBrasilAt(certificate, now);

    // AD-RB names the ICP-Brasil signature policy inside the CMS: claimed by
    // a certificate outside the chain, it is a statement the ITI's validator
    // refutes. Such a certificate signs the plain CMS instead.
    const profile: SignatureProfile = icpBrasil
      ? this.config.profile
      : "CMS_DETACHED";

    return {
      status: "SIGNED",
      intent: {
        status: "SIGNED",
        signer: { name: certificate.signerName, cnpj: certificate.signerCnpj },
        icpBrasil,
      },
      placeholder: {
        name: certificate.signerName,
        reason: "Comprovação de entrega",
        location: this.config.location,
        contactInfo: this.config.contact,
        subFilter:
          profile === "PADES_AD_RB"
            ? SUBFILTER_ETSI_CADES_DETACHED
            : SUBFILTER_ADOBE_PKCS7_DETACHED,
        signatureLength: this.config.signatureLength ?? SIGNATURE_LENGTH,
      },
      profile,
      certificate,
    };
  }

  /**
   * Fills the placeholder of `pdf`. The result is the final file: nothing
   * may be written after it (append-only, SigFlags 3), and its SHA-256 is
   * the one recorded and checked by /verificar.
   */
  async sign(
    pdf: Buffer,
    plan: Extract<SigningPlan, { status: "SIGNED" }>,
  ): Promise<Buffer> {
    const signer = new ProofCmsSigner(plan.certificate, plan.profile);

    return new SignPdf().sign(pdf, signer);
  }

  /** The DeliveryProofDocument columns for a document made under `plan`. */
  static record(plan: SigningPlan, signedAt: Date): SignatureRecord {
    if (plan.status === "UNSIGNED") {
      return {
        signature_status: "UNSIGNED",
        unsigned_reason: plan.reason,
        signature_profile: null,
        signer_name: null,
        signer_cnpj: null,
        cert_serial: null,
        cert_issuer: null,
        cert_not_after: null,
        signed_at: null,
        cert_icp_brasil: null,
      };
    }

    return {
      signature_status: "SIGNED",
      unsigned_reason: null,
      signature_profile: plan.profile,
      signer_name: plan.certificate.signerName,
      signer_cnpj: plan.certificate.signerCnpj,
      cert_serial: plan.certificate.serialHex,
      cert_issuer: plan.certificate.issuerName,
      cert_not_after: plan.certificate.notAfter,
      signed_at: signedAt,
      cert_icp_brasil:
        plan.intent.status === "SIGNED" && plan.intent.icpBrasil === true,
    };
  }
}

export { ProofSigningService, SIGNATURE_LENGTH, configFromEnv };
export type {
  ProofSigningConfig,
  ProofSigningEnv,
  ProofSigningHealth,
  SignatureRecord,
  SigningPlan,
  UnsignedReason,
};
