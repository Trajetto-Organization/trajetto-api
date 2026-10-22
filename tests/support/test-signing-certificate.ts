import forge from "node-forge";

import { generateKeyPairSync } from "node:crypto";

/**
 * A throwaway PFX for the proof-signing tests, generated in the test run
 * (decision 14.8): self-signed, with an issuer that SAYS "O=ICP-Brasil" so
 * the loader's checks can be exercised, and a CN in the e-CNPJ convention
 * "RAZAO SOCIAL:CNPJ". It is not, and could never pass as, a real ICP-Brasil
 * certificate: no chain to the ITI root exists for it.
 *
 * The RSA key comes from Node's native generator (forge's JS keygen takes
 * seconds for 2048 bits) and is handed to forge as PEM.
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
}

interface TestCertificate {
  pfx: Buffer;
  password: string;
  certificateDer: Buffer;
  certificatePem: string;
  serialHex: string;
}

const DAY = 24 * 60 * 60 * 1000;

let cachedKeys: Array<{ privateKeyPem: string; publicKeyPem: string }> = [];

function keyPair(index: number): {
  privateKeyPem: string;
  publicKeyPem: string;
} {
  // Two keys are enough for every case; generated once per test file.
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

function makeTestSigningCertificate(
  options: TestCertificateOptions = {},
): TestCertificate {
  const signing = keyPair(0);
  const other = keyPair(1);

  const privateKey = forge.pki.privateKeyFromPem(signing.privateKeyPem);
  const certKey = forge.pki.publicKeyFromPem(
    (options.mismatchedKey ? other : signing).publicKeyPem,
  );

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
  cert.setIssuer(name);

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

  // Self-signed by the signing key, whatever key the certificate carries.
  cert.sign(privateKey, forge.md.sha256.create());

  const password = options.password ?? "senha-de-teste";

  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], password, {
    algorithm: "3des",
  });

  const certificateDer = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    "binary",
  );

  return {
    pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"),
    password,
    certificateDer,
    certificatePem: forge.pki.certificateToPem(cert),
    serialHex: cert.serialNumber,
  };
}

export { makeTestSigningCertificate };
export type { TestCertificate, TestCertificateOptions };
