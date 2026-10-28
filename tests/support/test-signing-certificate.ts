import forge from "node-forge";

import { X509Certificate, generateKeyPairSync } from "node:crypto";

/**
 * A throwaway PFX for the proof-signing tests, generated in the test run
 * (decision 14.8), with a CN in the e-CNPJ convention "RAZAO SOCIAL:CNPJ".
 *
 * Two shapes:
 *
 * - `self-signed` (the default): an issuer that SAYS "O=ICP-Brasil" and
 *   nothing behind it — exactly what a hand-made certificate (the staging
 *   one) is. It must never be treated as ICP-Brasil: no chain to the ITI's
 *   roots exists for it.
 * - `test-root`: a three-link chain of the test's own, root → intermediate →
 *   signer, with the intermediate in the PFX like a real A1. `trustStore`
 *   holds the test root, so a test can stand in for the official roots and
 *   prove the chain walk without a real certificate.
 *
 * The RSA keys come from Node's native generator (forge's JS keygen takes
 * seconds for 2048 bits) and are handed to forge as PEM.
 */
interface TestCertificateOptions {
  commonName?: string;
  organization?: string;
  notBefore?: Date;
  notAfter?: Date;
  keyUsage?: {
    digitalSignature?: boolean;
    nonRepudiation?: boolean;
    keyEncipherment?: boolean;
  } | null;
  password?: string;
  /** Put a certificate for ANOTHER key in the PFX (key/cert mismatch). */
  mismatchedKey?: boolean;
  /** See the header. Default: self-signed. */
  chain?: "self-signed" | "test-root";
  /** test-root only: leave the intermediate out of the PFX. */
  omitIntermediate?: boolean;
  /** test-root only: the intermediate's validity window. */
  intermediateNotAfter?: Date;
}

interface TestCertificate {
  pfx: Buffer;
  password: string;
  certificateDer: Buffer;
  certificatePem: string;
  serialHex: string;
  /** The test root (test-root only; empty for a self-signed certificate). */
  trustStore: X509Certificate[];
}

const DAY = 24 * 60 * 60 * 1000;

let cachedKeys: Array<{ privateKeyPem: string; publicKeyPem: string }> = [];

function keyPair(index: number): {
  privateKeyPem: string;
  publicKeyPem: string;
} {
  // Four keys cover every case (signer, mismatch, root, intermediate);
  // generated once per test file.
  while (cachedKeys.length <= index) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    cachedKeys = [
      ...cachedKeys,
      { privateKeyPem: privateKey, publicKeyPem: publicKey },
    ];
  }

  return cachedKeys[index];
}

type Name = Array<{ shortName: string; value: string }>;

const ROOT_NAME: Name = [
  { shortName: "C", value: "BR" },
  { shortName: "O", value: "ICP-Brasil" },
  { shortName: "OU", value: "TESTE - NAO E UMA AC REAL" },
  { shortName: "CN", value: "AC Raiz de Teste do Trajetto" },
];

const INTERMEDIATE_NAME: Name = [
  { shortName: "C", value: "BR" },
  { shortName: "O", value: "ICP-Brasil" },
  { shortName: "OU", value: "TESTE - NAO E UMA AC REAL" },
  { shortName: "CN", value: "AC Intermediaria de Teste do Trajetto" },
];

function caCertificate(input: {
  subject: Name;
  issuer: Name;
  key: { privateKeyPem: string; publicKeyPem: string };
  signedBy: { privateKeyPem: string };
  serial: string;
  notAfter?: Date;
}): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();

  cert.publicKey = forge.pki.publicKeyFromPem(input.key.publicKeyPem);
  cert.serialNumber = input.serial;
  cert.validity.notBefore = new Date(Date.now() - 30 * DAY);
  cert.validity.notAfter = input.notAfter ?? new Date(Date.now() + 3650 * DAY);
  cert.setSubject(input.subject);
  cert.setIssuer(input.issuer);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(
    forge.pki.privateKeyFromPem(input.signedBy.privateKeyPem),
    forge.md.sha256.create(),
  );

  return cert;
}

function derOf(cert: forge.pki.Certificate): Buffer {
  return Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    "binary",
  );
}

function makeTestSigningCertificate(
  options: TestCertificateOptions = {},
): TestCertificate {
  const signing = keyPair(0);
  const other = keyPair(1);
  const chained = options.chain === "test-root";

  const privateKey = forge.pki.privateKeyFromPem(signing.privateKeyPem);
  const certKey = forge.pki.publicKeyFromPem(
    (options.mismatchedKey ? other : signing).publicKeyPem,
  );

  const root = chained
    ? caCertificate({
        subject: ROOT_NAME,
        issuer: ROOT_NAME,
        key: keyPair(2),
        signedBy: keyPair(2),
        serial: "01",
      })
    : null;

  const intermediate = chained
    ? caCertificate({
        subject: INTERMEDIATE_NAME,
        issuer: ROOT_NAME,
        key: keyPair(3),
        signedBy: keyPair(2),
        serial: "02",
        notAfter: options.intermediateNotAfter,
      })
    : null;

  const cert = forge.pki.createCertificate();

  cert.publicKey = certKey;
  cert.serialNumber = "0a1b2c3d4e5f";
  cert.validity.notBefore = options.notBefore ?? new Date(Date.now() - DAY);
  cert.validity.notAfter = options.notAfter ?? new Date(Date.now() + 365 * DAY);

  const name = [
    { shortName: "C", value: "BR" },
    { shortName: "O", value: options.organization ?? "ICP-Brasil" },
    { shortName: "OU", value: "Assinatura Tipo A1" },
    {
      shortName: "CN",
      value:
        options.commonName ?? "TRAJETTO SISTEMAS TESTE LTDA:11222333000181",
    },
  ];

  cert.setSubject(name);
  cert.setIssuer(chained ? INTERMEDIATE_NAME : name);

  const extensions: object[] = [{ name: "basicConstraints", cA: false }];

  if (options.keyUsage !== null) {
    extensions.push({
      name: "keyUsage",
      digitalSignature: true,
      nonRepudiation: true,
      ...(options.keyUsage ?? {}),
    });
  }

  cert.setExtensions(extensions);

  // Self-signed by the signing key, whatever key the certificate carries;
  // or by the intermediate's key, in the test chain.
  cert.sign(
    chained
      ? forge.pki.privateKeyFromPem(keyPair(3).privateKeyPem)
      : privateKey,
    forge.md.sha256.create(),
  );

  const password = options.password ?? "senha-de-teste";

  const bundled =
    intermediate && !options.omitIntermediate ? [cert, intermediate] : [cert];

  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, bundled, password, {
    algorithm: "3des",
  });

  return {
    pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"),
    password,
    certificateDer: derOf(cert),
    certificatePem: forge.pki.certificateToPem(cert),
    serialHex: cert.serialNumber,
    trustStore: root ? [new X509Certificate(derOf(root))] : [],
  };
}

export { makeTestSigningCertificate };
export type { TestCertificate, TestCertificateOptions };
