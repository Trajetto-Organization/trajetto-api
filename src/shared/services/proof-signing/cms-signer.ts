import forge from "node-forge";
import { Signer } from "@signpdf/utils";

import { createHash, sign as rsaSign } from "node:crypto";

import type { LoadedCertificate } from "./signing-certificate";

/**
 * The CMS (PKCS#7 SignedData, detached) that goes into the PDF's /Contents
 * (decision 14.8, design §6.2).
 *
 * Two profiles:
 *
 * - `PADES_AD_RB` — PAdES with the ICP-Brasil AD-RB v1.1 policy: signed
 *   attributes contentType, messageDigest, signingCertificateV2 and
 *   sigPolicyId (OID 2.16.76.1.7.1.11.1.1 + the SHA-256 of the policy file),
 *   and NO signingTime — in PAdES the claimed time is the /M of the /Sig.
 * - `CMS_DETACHED` — the plain detached CMS the validated model carries
 *   (contentType, signingTime, messageDigest), kept as the escape hatch if
 *   the ITI validator ever rejects the AD-RB for some detail.
 *
 * Built by hand with node-forge's ASN.1 rather than forge's pkcs7 writer:
 * that one cannot emit signingCertificateV2 or sigPolicyId. The RSA
 * signature itself is Node's native crypto, not forge's JS bignums.
 */
type SignatureProfile = "PADES_AD_RB" | "CMS_DETACHED";

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  sigPolicyId: "1.2.840.113549.1.9.16.2.15",
  spqEtsUri: "1.2.840.113549.1.9.16.5.1",
} as const;

/**
 * ICP-Brasil PAdES AD-RB v1.1, measured on the official files (design §6.2):
 * the OID in the LPA and the SHA-256 of PA_PAdES_AD_RB_v1_1.der.
 */
const AD_RB_POLICY = {
  oid: "2.16.76.1.7.1.11.1.1",
  sha256: "95752d26ca974d46675ae7fb787b606a71ea941f26b59f6b6a321f97d63b9cb1",
  uri: "http://politicas.icpbrasil.gov.br/PA_PAdES_AD_RB_v1_1.der",
} as const;

const { asn1 } = forge;
type Node = forge.asn1.Asn1;

const binary = (bytes: Buffer) => bytes.toString("binary");

const sequence = (...value: Node[]): Node =>
  asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, value);

const set = (...value: Node[]): Node =>
  asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, value);

const oid = (value: string): Node =>
  asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.OID,
    false,
    asn1.oidToDer(value).getBytes(),
  );

const octets = (bytes: Buffer): Node =>
  asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.OCTETSTRING,
    false,
    binary(bytes),
  );

const nullValue = (): Node =>
  asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "");

const integer = (value: number): Node =>
  asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.INTEGER,
    false,
    asn1.integerToDer(value).getBytes(),
  );

const context = (tag: number, value: Node[]): Node =>
  asn1.create(asn1.Class.CONTEXT_SPECIFIC, tag as forge.asn1.Type, true, value);

const toDer = (node: Node): Buffer =>
  Buffer.from(asn1.toDer(node).getBytes(), "binary");

const fromDer = (bytes: Buffer): Node =>
  asn1.fromDer(forge.util.createBuffer(binary(bytes)));

const algorithm = (value: string): Node => sequence(oid(value), nullValue());

const attribute = (type: string, value: Node): Node =>
  sequence(oid(type), set(value));

/** The issuer Name and serial INTEGER nodes, exactly as in the certificate. */
function issuerAndSerial(certificateDer: Buffer): {
  issuer: Node;
  serial: Node;
} {
  const certificate = fromDer(certificateDer).value as Node[];
  const tbs = certificate[0].value as Node[];

  // tbsCertificate: [0] version (optional), serialNumber, signature, issuer…
  const offset = tbs[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;

  return { issuer: tbs[offset + 2], serial: tbs[offset] };
}

/**
 * The signed attributes, DER-sorted as a SET OF must be: the signature is
 * over this exact encoding, and a validator re-encodes it sorted.
 */
function signedAttributes(
  profile: SignatureProfile,
  digest: Buffer,
  certificate: LoadedCertificate,
  signingTime: Date,
): Node[] {
  const attributes: Node[] = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(digest)),
  ];

  if (profile === "CMS_DETACHED") {
    attributes.push(
      attribute(
        OID.signingTime,
        asn1.create(
          asn1.Class.UNIVERSAL,
          asn1.Type.UTCTIME,
          false,
          asn1.dateToUtcTime(signingTime),
        ),
      ),
    );
  } else {
    const { issuer, serial } = issuerAndSerial(certificate.certificateDer);
    const certificateHash = createHash("sha256")
      .update(certificate.certificateDer)
      .digest();

    // SigningCertificateV2 { certs: [ESSCertIDv2 { certHash, issuerSerial }] }.
    // hashAlgorithm is omitted: its DEFAULT is SHA-256 (RFC 5035).
    attributes.push(
      attribute(
        OID.signingCertificateV2,
        sequence(
          sequence(
            sequence(
              octets(certificateHash),
              // GeneralNames [ directoryName [4] EXPLICIT Name ], serial.
              sequence(sequence(context(4, [issuer])), serial),
            ),
          ),
        ),
      ),
      attribute(
        OID.sigPolicyId,
        sequence(
          oid(AD_RB_POLICY.oid),
          sequence(
            algorithm(OID.sha256),
            octets(Buffer.from(AD_RB_POLICY.sha256, "hex")),
          ),
          sequence(
            sequence(
              oid(OID.spqEtsUri),
              asn1.create(
                asn1.Class.UNIVERSAL,
                asn1.Type.IA5STRING,
                false,
                AD_RB_POLICY.uri,
              ),
            ),
          ),
        ),
      ),
    );
  }

  return attributes
    .map((node) => ({ node, der: toDer(node) }))
    .sort((left, right) => Buffer.compare(left.der, right.der))
    .map((entry) => entry.node);
}

/**
 * The DER ContentInfo for `content` (the PDF bytes the ByteRange covers).
 * Exported for the tests, which verify it independently.
 */
function buildDetachedCms(
  content: Buffer,
  certificate: LoadedCertificate,
  profile: SignatureProfile,
  signingTime: Date = new Date(),
): Buffer {
  const digest = createHash("sha256").update(content).digest();
  const attributes = signedAttributes(
    profile,
    digest,
    certificate,
    signingTime,
  );

  // Signed as an explicit SET OF (tag 0x31), stored as [0] IMPLICIT.
  const signature = rsaSign(
    "sha256",
    toDer(set(...attributes)),
    certificate.privateKey,
  );

  const { issuer, serial } = issuerAndSerial(certificate.certificateDer);

  const signerInfo = sequence(
    integer(1),
    sequence(issuer, serial),
    algorithm(OID.sha256),
    context(0, attributes),
    algorithm(OID.rsaEncryption),
    octets(signature),
  );

  const signedData = sequence(
    integer(1),
    set(algorithm(OID.sha256)),
    // Detached: the content type only, no eContent.
    sequence(oid(OID.data)),
    context(
      0,
      [certificate.certificateDer, ...certificate.chainDer].map(fromDer),
    ),
    set(signerInfo),
  );

  return toDer(sequence(oid(OID.signedData), context(0, [signedData])));
}

/** The @signpdf Signer: what `SignPdf.sign` calls with the ByteRange bytes. */
class ProofCmsSigner extends Signer {
  constructor(
    private readonly certificate: LoadedCertificate,
    private readonly profile: SignatureProfile,
  ) {
    super();
  }

  async sign(pdfBuffer: Buffer, signingTime?: Date): Promise<Buffer> {
    return buildDetachedCms(
      pdfBuffer,
      this.certificate,
      this.profile,
      signingTime,
    );
  }
}

export { AD_RB_POLICY, OID as CMS_OID, ProofCmsSigner, buildDetachedCms };
export type { SignatureProfile };
