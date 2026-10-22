import forge from "node-forge";

import { createPrivateKey, type KeyObject } from "node:crypto";

import { isValidCnpj } from "@/shared/delivery/cnpj";

/**
 * The platform's ICP-Brasil A1 certificate (e-CNPJ), opened from the PFX the
 * owner configures (decision 14.8, design §6.3).
 *
 * Opened once and turned into a STATE, not an exception: a wrong password or
 * an expired certificate must not take the API down — the receipts then go
 * out unsigned and say so, with the reason recorded on each document.
 *
 * Nothing here ever logs or returns the PFX, its password or the key.
 */
interface LoadedCertificate {
  /** DER of the signer's certificate, as embedded in the CMS. */
  certificateDer: Buffer;

  /** The rest of the chain the PFX carried, DER, for validators without AIA. */
  chainDer: Buffer[];

  privateKey: KeyObject;

  /** CN before ':' on an e-CNPJ ("RAZAO SOCIAL:CNPJ"), the whole CN otherwise. */
  signerName: string;

  /** CN after ':' when it is a valid CNPJ; null otherwise (never invented). */
  signerCnpj: string | null;

  serialHex: string;

  /** The issuer's CN, e.g. "AC Certisign Multipla G7". */
  issuerName: string;

  notBefore: Date;
  notAfter: Date;
}

type CertificateState =
  | { state: "READY"; certificate: LoadedCertificate }
  | { state: "EXPIRED"; certificate: LoadedCertificate }
  | {
      state: "INVALID";
      reason: string;
      /**
       * Only for NOT_YET_VALID: the certificate is sound, its window has not
       * started. Kept so the service can turn it READY once it does.
       */
      certificate?: LoadedCertificate;
    }
  | { state: "ABSENT" }
  | { state: "DISABLED" };

interface CertificateInput {
  /** The PFX bytes; null when none is configured. */
  pfx: Buffer | null;
  password: string | undefined;
  disabled?: boolean;
}

/** An attribute's value as text: forge leaves UTF8String as raw bytes. */
function attributeText(
  attribute: { value?: unknown; valueTagClass?: number } | null,
): string | null {
  if (!attribute || typeof attribute.value !== "string") return null;

  if (attribute.valueTagClass === forge.asn1.Type.UTF8) {
    try {
      return forge.util.decodeUtf8(attribute.value);
    } catch {
      return attribute.value;
    }
  }

  return attribute.value;
}

function fieldText(
  name: forge.pki.Certificate["subject"],
  shortName: string,
): string | null {
  const attribute = name.attributes.find(
    (entry) => entry.shortName === shortName,
  );

  return attributeText(attribute ?? null)?.trim() || null;
}

/** "RAZAO SOCIAL:12345678000199" → name and CNPJ (the e-CNPJ convention). */
function splitCommonName(commonName: string): {
  name: string;
  cnpj: string | null;
} {
  const separator = commonName.lastIndexOf(":");

  if (separator > 0) {
    const cnpj = commonName.slice(separator + 1).replace(/\D/g, "");

    if (isValidCnpj(cnpj)) {
      return { name: commonName.slice(0, separator).trim(), cnpj };
    }
  }

  return { name: commonName.trim(), cnpj: null };
}

function isIcpBrasil(certificate: forge.pki.Certificate): boolean {
  return certificate.issuer.attributes.some(
    (attribute) =>
      attribute.shortName === "O" && attributeText(attribute) === "ICP-Brasil",
  );
}

function derOf(certificate: forge.pki.Certificate): Buffer {
  return Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
    "binary",
  );
}

function sameKey(
  certificate: forge.pki.Certificate,
  key: forge.pki.rsa.PrivateKey,
): boolean {
  const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey;

  return (
    Boolean(publicKey?.n && key.n) &&
    publicKey.n.equals(key.n) &&
    publicKey.e.equals(key.e)
  );
}

/**
 * Opens and checks the PFX.
 *
 * READY needs: the password opens it, an RSA key whose certificate is in it,
 * an ICP-Brasil issuer (O=ICP-Brasil), a key usage that allows signing, and
 * a validity window that has started. Past `notAfter` it is EXPIRED (the
 * certificate is still described, for the operations alert).
 */
function loadSigningCertificate(
  input: CertificateInput,
  now: Date = new Date(),
): CertificateState {
  if (input.disabled) return { state: "DISABLED" };
  if (!input.pfx || input.pfx.length === 0) return { state: "ABSENT" };

  let pfx: forge.pkcs12.Pkcs12Pfx;

  try {
    const asn1 = forge.asn1.fromDer(
      forge.util.createBuffer(input.pfx.toString("binary")),
    );

    pfx = forge.pkcs12.pkcs12FromAsn1(asn1, false, input.password ?? "");
  } catch {
    // Wrong password and a corrupt file are indistinguishable here, and the
    // message must not hint at either the password or the content.
    return { state: "INVALID", reason: "PFX_UNREADABLE" };
  }

  const keyBags = [
    ...(pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? []),
    ...(pfx.getBags({ bagType: forge.pki.oids.keyBag })[
      forge.pki.oids.keyBag
    ] ?? []),
  ];

  const certificates = (
    pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ??
    []
  )
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => Boolean(cert));

  // forge only decodes RSA keys; ICP-Brasil A1 certificates are RSA.
  const key = keyBags.map((bag) => bag.key).find((entry) => Boolean(entry));

  if (!key) return { state: "INVALID", reason: "NO_RSA_KEY" };

  const signer = certificates.find((cert) => sameKey(cert, key));

  if (!signer) return { state: "INVALID", reason: "KEY_CERTIFICATE_MISMATCH" };

  if (!isIcpBrasil(signer))
    return { state: "INVALID", reason: "NOT_ICP_BRASIL" };

  const usage = signer.getExtension("keyUsage") as {
    digitalSignature?: boolean;
    nonRepudiation?: boolean;
  } | null;

  if (usage && !usage.digitalSignature && !usage.nonRepudiation) {
    return { state: "INVALID", reason: "KEY_USAGE" };
  }

  const commonName = fieldText(signer.subject, "CN");

  if (!commonName) return { state: "INVALID", reason: "NO_COMMON_NAME" };

  const { name, cnpj } = splitCommonName(commonName);

  let privateKey: KeyObject;

  try {
    privateKey = createPrivateKey(forge.pki.privateKeyToPem(key));
  } catch {
    return { state: "INVALID", reason: "KEY_UNUSABLE" };
  }

  const certificate: LoadedCertificate = {
    certificateDer: derOf(signer),
    chainDer: certificates.filter((cert) => cert !== signer).map(derOf),
    privateKey,
    signerName: name,
    signerCnpj: cnpj,
    serialHex: signer.serialNumber.toLowerCase(),
    issuerName:
      fieldText(signer.issuer, "CN") ?? fieldText(signer.issuer, "O") ?? "",
    notBefore: signer.validity.notBefore,
    notAfter: signer.validity.notAfter,
  };

  return certificateWindowState(certificate, now);
}

/**
 * Where `now` falls in a loaded certificate's validity window. Separate from
 * loading so a long-lived process re-reads it per document: a certificate
 * installed before its notBefore turns READY, and READY turns EXPIRED.
 */
function certificateWindowState(
  certificate: LoadedCertificate,
  now: Date = new Date(),
): CertificateState {
  if (now.getTime() < certificate.notBefore.getTime()) {
    return { state: "INVALID", reason: "NOT_YET_VALID", certificate };
  }

  if (now.getTime() > certificate.notAfter.getTime()) {
    return { state: "EXPIRED", certificate };
  }

  return { state: "READY", certificate };
}

export { certificateWindowState, loadSigningCertificate, splitCommonName };
export type { CertificateInput, CertificateState, LoadedCertificate };
