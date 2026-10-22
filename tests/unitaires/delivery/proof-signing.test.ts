import { describe, expect, it } from "vitest";

import forge from "node-forge";

import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProofDocumentModel,
  type ProofDocumentSource,
} from "@/shared/delivery/proof-document";
import { renderProofPdf } from "@/shared/services/proof-pdf-service";
import {
  AD_RB_POLICY,
  CMS_OID,
} from "@/shared/services/proof-signing/cms-signer";
import {
  ProofSigningService,
  configFromEnv,
  type ProofSigningConfig,
  type ProofSigningEnv,
} from "@/shared/services/proof-signing/proof-signing-service";
import { loadSigningCertificate } from "@/shared/services/proof-signing/signing-certificate";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

import { makeTestSigningCertificate } from "../../support/test-signing-certificate";

/**
 * The ICP-Brasil signature of the proof PDF (decision 14.8, design §6),
 * proven on a real rendered and signed file with a certificate generated
 * HERE (self-signed, "O=ICP-Brasil" in name only — never a real one).
 *
 * The signature is verified independently of the code that made it: the
 * CMS is parsed from the PDF's /Contents with forge's ASN.1 reader, the
 * digest is recomputed over the /ByteRange, and the RSA signature is checked
 * with Node's crypto against the certificate's public key.
 */
const DAY = 24 * 60 * 60 * 1000;

function source(): ProofDocumentSource {
  return {
    delivery: {
      id: "018f0000-0000-7000-8000-0000000000e1",
      code: "PED-1",
      status: "DELIVERED",
      invoice_key: null,
      invoice_number: "45515",
      recipient_name: "Supermercado Cabral Ltda",
      recipient_document: "30970502000106",
      street: "Rua Alberto de Oliveira Santos",
      address_number: "494",
      complement: null,
      neighborhood: null,
      city: "Vila Velha",
      uf: "ES",
      cep: "29106100",
      delivered_at: new Date("2026-09-30T16:30:26Z"),
      received_by: null,
      shipper: null,
    },
    business: {
      corporate_reason: "Multipla Distribuidora Ltda",
      cnpj: "31358035000120",
      timezone: "America/Sao_Paulo",
    },
    driver: { name: "Rogerio Viana", cpf: "09797417778" },
    route: { code: 5696, name: null },
    proof: {
      created_at: new Date("2026-09-30T16:30:26Z"),
      latitude: -20.3502181,
      longitude: -40.3038332,
      photoKey: null,
      signatureKey: null,
    },
    occurrences: [],
  };
}

function config(
  overrides: Partial<ProofSigningConfig> = {},
): ProofSigningConfig {
  const certificate = makeTestSigningCertificate();

  return {
    pfx: certificate.pfx,
    password: certificate.password,
    profile: "PADES_AD_RB",
    disabled: false,
    location: "Rio de Janeiro, RJ",
    contact: "suporte@trajetto.com.br",
    ...overrides,
  };
}

async function signedPdf(service: ProofSigningService): Promise<Buffer> {
  const plan = service.plan();

  if (plan.status !== "SIGNED")
    throw new Error(`expected SIGNED, got ${plan.reason}`);

  const model = buildProofDocumentModel(source(), {
    verificationBaseUrl: "https://app.trajetto.com.br",
    verificationToken: "ab".repeat(32),
    signing: plan.intent,
  });

  const rendered = await renderProofPdf(
    model,
    { photo: null, signature: null },
    { signaturePlaceholder: plan.placeholder },
  );

  return service.sign(rendered.bytes, plan);
}

type Node = forge.asn1.Asn1;

/** The ByteRange, the CMS and the bytes the signature covers. */
function extractSignature(pdf: Buffer): {
  byteRange: number[];
  cms: Node;
  covered: Buffer;
} {
  const text = pdf.toString("latin1");
  const match = /\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\s*\]/.exec(text);

  if (!match) throw new Error("no ByteRange");

  const byteRange = match.slice(1).map(Number);

  const hex = text.slice(byteRange[1] + 1, byteRange[2] - 1);
  const der = Buffer.from(hex, "hex");

  const cms = (
    forge.asn1.fromDer as unknown as (b: unknown, o: unknown) => Node
  )(forge.util.createBuffer(der.toString("binary")), { parseAllBytes: false });

  const covered = Buffer.concat([
    pdf.subarray(byteRange[0], byteRange[0] + byteRange[1]),
    pdf.subarray(byteRange[2], byteRange[2] + byteRange[3]),
  ]);

  return { byteRange, cms, covered };
}

const oidOf = (node: Node) => forge.asn1.derToOid(node.value as string);

function signerInfo(cms: Node) {
  const signedData = ((cms.value as Node[])[1].value as Node[])[0]
    .value as Node[];
  const certificates = (signedData[3].value as Node[]).map((node) =>
    Buffer.from(forge.asn1.toDer(node).getBytes(), "binary"),
  );
  const info = (signedData[4].value as Node[])[0].value as Node[];

  const attributesNode = info[3];
  const attributes = new Map(
    (attributesNode.value as Node[]).map((attribute) => {
      const [type, values] = attribute.value as Node[];
      return [oidOf(type), (values.value as Node[])[0]] as const;
    }),
  );

  return {
    contentType: oidOf((cms.value as Node[])[0]),
    certificates,
    attributesNode,
    attributes,
    signature: Buffer.from(info[5].value as string, "binary"),
  };
}

function verifyRsa(
  attributesNode: Node,
  signature: Buffer,
  certificateDer: Buffer,
): boolean {
  // Signed as an explicit SET OF: the [0] IMPLICIT tag swapped back to 0x31.
  const set = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SET,
    true,
    attributesNode.value as Node[],
  );

  const der = Buffer.from(forge.asn1.toDer(set).getBytes(), "binary");
  const publicKey = createPublicKey({
    key: certificateDer,
    format: "der",
    type: "spki",
  } as never);

  return verify("sha256", der, publicKey, signature);
}

function publicKeyDer(certificateDer: Buffer): Buffer {
  const cert = forge.pki.certificateFromAsn1(
    forge.asn1.fromDer(
      forge.util.createBuffer(certificateDer.toString("binary")),
    ),
  );
  const pem = forge.pki.publicKeyToPem(cert.publicKey);

  return createPublicKey(pem).export({ type: "spki", format: "der" });
}

describe("the platform certificate", () => {
  it("is READY with the signer's name and CNPJ read from its CN", () => {
    const certificate = makeTestSigningCertificate();
    const state = loadSigningCertificate({
      pfx: certificate.pfx,
      password: certificate.password,
    });

    expect(state.state).toBe("READY");
    if (state.state !== "READY") return;

    expect(state.certificate.signerName).toBe("TRAJETTO SISTEMAS TESTE LTDA");
    expect(state.certificate.signerCnpj).toBe("11222333000181");
    expect(state.certificate.serialHex).toBe(certificate.serialHex);
  });

  it("leaves the CNPJ out when the CN does not carry a valid one", () => {
    const certificate = makeTestSigningCertificate({
      commonName: "EMPRESA SEM CNPJ:12345678000100",
    });
    const state = loadSigningCertificate({
      pfx: certificate.pfx,
      password: certificate.password,
    });

    expect(state.state).toBe("READY");
    if (state.state !== "READY") return;

    expect(state.certificate.signerCnpj).toBeNull();
    expect(state.certificate.signerName).toBe(
      "EMPRESA SEM CNPJ:12345678000100",
    );
  });

  it("is EXPIRED past notAfter, and READY turns EXPIRED as time passes", () => {
    const expired = makeTestSigningCertificate({
      notBefore: new Date(Date.now() - 400 * DAY),
      notAfter: new Date(Date.now() - DAY),
    });

    expect(
      loadSigningCertificate({ pfx: expired.pfx, password: expired.password })
        .state,
    ).toBe("EXPIRED");

    const service = new ProofSigningService(config());

    expect(service.state().state).toBe("READY");
    expect(service.state(new Date(Date.now() + 400 * DAY)).state).toBe(
      "EXPIRED",
    );
    expect(service.plan(new Date(Date.now() + 400 * DAY))).toMatchObject({
      status: "UNSIGNED",
      reason: "CERTIFICATE_EXPIRED",
    });
  });

  it("turns READY once a certificate installed before its notBefore starts", () => {
    // Regression: NOT_YET_VALID used to be cached as INVALID for the life of
    // the process, so a renewal installed a day early never signed.
    const early = makeTestSigningCertificate({
      notBefore: new Date(Date.now() + DAY),
      notAfter: new Date(Date.now() + 400 * DAY),
    });
    const service = new ProofSigningService(
      config({ pfx: early.pfx, password: early.password }),
    );

    expect(service.state()).toMatchObject({
      state: "INVALID",
      reason: "NOT_YET_VALID",
    });
    expect(service.plan()).toMatchObject({
      status: "UNSIGNED",
      reason: "CERTIFICATE_INVALID",
    });

    const later = new Date(Date.now() + 2 * DAY);

    expect(service.state(later).state).toBe("READY");
    expect(service.plan(later).status).toBe("SIGNED");
    expect(service.state(new Date(Date.now() + 401 * DAY)).state).toBe(
      "EXPIRED",
    );
  });

  it("is opened at boot by warmUp, which never throws", () => {
    let reads = 0;
    const certificate = makeTestSigningCertificate();
    const service = new ProofSigningService(
      config({
        pfx: () => {
          reads += 1;
          return certificate.pfx;
        },
        password: certificate.password,
      }),
    );

    expect(service.warmUp().state).toBe("READY");
    expect(reads).toBe(1);

    // The PFX is not re-read per document.
    service.plan();
    expect(reads).toBe(1);

    const broken = new ProofSigningService(
      config({
        pfx: () => {
          throw new Error("secret file vanished");
        },
      }),
    );

    expect(broken.warmUp()).toEqual({
      state: "INVALID",
      reason: "PFX_FILE_UNREADABLE",
    });
    expect(broken.plan()).toMatchObject({
      status: "UNSIGNED",
      reason: "CERTIFICATE_INVALID",
    });
  });

  it("never throws from plan() when the secret read fails and warmUp never ran", () => {
    const broken = new ProofSigningService(
      config({
        pfx: () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
      }),
    );

    expect(() => broken.plan()).not.toThrow();
    expect(broken.plan()).toMatchObject({
      status: "UNSIGNED",
      reason: "CERTIFICATE_INVALID",
    });
    expect(broken.available()).toBe(false);
    expect(broken.state()).toEqual({
      state: "INVALID",
      reason: "PFX_FILE_UNREADABLE",
    });
  });

  it("tells a missing PFX file apart from a wrong password", () => {
    const certificate = makeTestSigningCertificate();
    const base = {
      PROOF_SIGNING_PFX_BASE64: undefined,
      PROOF_SIGNATURE_PROFILE: "pades",
      PROOF_SIGNING_DISABLED: false,
      PROOF_SIGNER_LOCATION: "Rio de Janeiro, RJ",
      PROOF_SIGNER_CONTACT: "suporte@trajetto.com.br",
    } as const;

    const missingFile = new ProofSigningService(
      configFromEnv({
        ...base,
        PROOF_SIGNING_PFX_PATH: join(
          tmpdir(),
          `trajetto-no-such-${randomUUID()}.pfx`,
        ),
        PROOF_SIGNING_PFX_PASSWORD: certificate.password,
      } as unknown as ProofSigningEnv),
    );

    expect(missingFile.warmUp()).toEqual({
      state: "INVALID",
      reason: "PFX_FILE_UNREADABLE",
    });

    const wrongPassword = new ProofSigningService(
      configFromEnv({
        ...base,
        PROOF_SIGNING_PFX_BASE64: certificate.pfx.toString("base64"),
        PROOF_SIGNING_PFX_PATH: undefined,
        PROOF_SIGNING_PFX_PASSWORD: "errada",
      } as unknown as ProofSigningEnv),
    );

    expect(wrongPassword.warmUp()).toEqual({
      state: "INVALID",
      reason: "PFX_UNREADABLE",
    });
  });

  it.each([
    ["the wrong password", { password: "outra" }, "PFX_UNREADABLE"],
    [
      "a certificate for another key",
      { mismatchedKey: true },
      "KEY_CERTIFICATE_MISMATCH",
    ],
    [
      "an issuer outside ICP-Brasil",
      { organization: "Outra AC" },
      "NOT_ICP_BRASIL",
    ],
    [
      "a key usage that does not allow signing",
      {
        keyUsage: {
          digitalSignature: false,
          nonRepudiation: false,
          keyEncipherment: true,
        },
      },
      "KEY_USAGE",
    ],
  ] as const)("is INVALID with %s", (_, options, reason) => {
    const certificate = makeTestSigningCertificate(
      "password" in options ? {} : (options as object),
    );

    const state = loadSigningCertificate({
      pfx: certificate.pfx,
      password: "password" in options ? options.password : certificate.password,
    });

    expect(state).toEqual({ state: "INVALID", reason });
  });

  it("is ABSENT without a PFX and DISABLED when switched off", () => {
    expect(
      loadSigningCertificate({ pfx: null, password: undefined }).state,
    ).toBe("ABSENT");

    const certificate = makeTestSigningCertificate();

    expect(
      loadSigningCertificate({
        pfx: certificate.pfx,
        password: certificate.password,
        disabled: true,
      }).state,
    ).toBe("DISABLED");

    expect(new ProofSigningService(config({ pfx: null })).plan()).toMatchObject(
      {
        status: "UNSIGNED",
        reason: "NO_CERTIFICATE",
      },
    );
    expect(
      new ProofSigningService(config({ disabled: true })).plan(),
    ).toMatchObject({
      status: "UNSIGNED",
      reason: "SIGNING_DISABLED",
    });
    expect(
      new ProofSigningService(config({ password: "errada" })).plan(),
    ).toMatchObject({
      status: "UNSIGNED",
      reason: "CERTIFICATE_INVALID",
    });
  });

  it("is refused by the env schema when given both as base64 and as a path", () => {
    // The test run's own (valid) environment, plus the two sources.
    const base = definedEnv(process.env);

    const both = envSchema.safeParse({
      ...base,
      PROOF_SIGNING_PFX_BASE64: "AAAA",
      PROOF_SIGNING_PFX_PATH: "/run/secrets/proof_signing.pfx",
    });

    expect(both.success).toBe(false);
    expect(both.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "PROOF_SIGNING_PFX_PATH",
    ]);

    expect(
      envSchema.safeParse({ ...base, PROOF_SIGNING_PFX_BASE64: "AAAA" })
        .success,
    ).toBe(true);
  });

  it("requires the map's attribution with its URL, and refuses a CNPJ that is not one", () => {
    const base = definedEnv(process.env);

    const map = envSchema.safeParse({
      ...base,
      PROOF_MAP_TILE_URL: "https://tiles.example.com/{z}/{x}/{y}.png",
    });

    expect(map.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "PROOF_MAP_TILE_ATTRIBUTION",
    ]);

    const cnpj = envSchema.safeParse({
      ...base,
      PROOF_ISSUER_CNPJ: "11.222.333/0001-80",
    });

    expect(cnpj.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "PROOF_ISSUER_CNPJ",
    ]);
    expect(
      envSchema.safeParse({ ...base, PROOF_ISSUER_CNPJ: "11.222.333/0001-81" })
        .data?.PROOF_ISSUER_CNPJ,
    ).toBe("11222333000181");
  });
});

describe("a signed proof PDF (PAdES ICP-Brasil AD-RB)", () => {
  it("covers the whole file except /Contents, and nothing is written after", async () => {
    const pdf = await signedPdf(new ProofSigningService(config()));
    const { byteRange } = extractSignature(pdf);

    expect(byteRange[0]).toBe(0);
    expect(byteRange[2] + byteRange[3]).toBe(pdf.length);
    expect(pdf[byteRange[1]]).toBe("<".charCodeAt(0));
    expect(pdf[byteRange[2] - 1]).toBe(">".charCodeAt(0));

    const text = pdf.toString("latin1");

    expect(text).toContain("/SubFilter /ETSI.CAdES.detached");
    expect(text).toContain("/Filter /Adobe.PPKLite");
    // Invisible widget, as in the model; signatures exist + append only.
    expect(text).toMatch(/\/Rect \[0 0 0 0\]/);
    expect(text).toMatch(/\/SigFlags 3/);
    // One revision: the file ends with the only %%EOF.
    expect(text.match(/%%EOF/g)).toHaveLength(1);
  });

  it("carries the four AD-RB signed attributes, no signingTime, and a signature that verifies", async () => {
    const service = new ProofSigningService(config());
    const pdf = await signedPdf(service);
    const { cms, covered } = extractSignature(pdf);

    const info = signerInfo(cms);

    expect(info.contentType).toBe(CMS_OID.signedData);
    expect([...info.attributes.keys()].sort()).toEqual(
      [
        CMS_OID.contentType,
        CMS_OID.messageDigest,
        CMS_OID.signingCertificateV2,
        CMS_OID.sigPolicyId,
      ].sort(),
    );
    expect(info.attributes.has(CMS_OID.signingTime)).toBe(false);

    // messageDigest = SHA-256 of exactly what the ByteRange covers.
    const digest = Buffer.from(
      info.attributes.get(CMS_OID.messageDigest)!.value as string,
      "binary",
    );
    expect(digest.equals(createHash("sha256").update(covered).digest())).toBe(
      true,
    );

    // sigPolicyId: the AD-RB v1.1 OID and the hash of the policy file.
    const policy = info.attributes.get(CMS_OID.sigPolicyId)!.value as Node[];
    expect(oidOf(policy[0])).toBe(AD_RB_POLICY.oid);
    const policyHash = (policy[1].value as Node[])[1];
    expect(
      Buffer.from(policyHash.value as string, "binary").toString("hex"),
    ).toBe("95752d26ca974d46675ae7fb787b606a71ea941f26b59f6b6a321f97d63b9cb1");

    // signingCertificateV2 binds the signer's certificate by its SHA-256.
    const signerCert = info.certificates[0];
    const essCertId = (
      (info.attributes.get(CMS_OID.signingCertificateV2)!.value as Node[])[0]
        .value as Node[]
    )[0].value as Node[];
    expect(
      Buffer.from(essCertId[0].value as string, "binary").equals(
        createHash("sha256").update(signerCert).digest(),
      ),
    ).toBe(true);

    expect(
      verifyRsa(info.attributesNode, info.signature, publicKeyDer(signerCert)),
    ).toBe(true);
  });

  it("no longer verifies once a covered byte changes", async () => {
    const pdf = await signedPdf(new ProofSigningService(config()));
    const tampered = Buffer.from(pdf);

    // A byte of the page content, well before the signature dictionary.
    const at = tampered.indexOf("Comprova");
    tampered[at] = "X".charCodeAt(0);

    const { cms, covered } = extractSignature(tampered);
    const info = signerInfo(cms);
    const digest = Buffer.from(
      info.attributes.get(CMS_OID.messageDigest)!.value as string,
      "binary",
    );

    expect(digest.equals(createHash("sha256").update(covered).digest())).toBe(
      false,
    );
  });

  it("prints the signed wording, with the signer taken from the certificate", async () => {
    const service = new ProofSigningService(config());
    const plan = service.plan();

    expect(plan.status).toBe("SIGNED");
    if (plan.status !== "SIGNED") return;

    expect(plan.intent).toEqual({
      status: "SIGNED",
      signer: { name: "TRAJETTO SISTEMAS TESTE LTDA", cnpj: "11222333000181" },
    });
    expect(
      ProofSigningService.record(plan, new Date("2026-10-05T12:00:00Z")),
    ).toMatchObject({
      signature_status: "SIGNED",
      unsigned_reason: null,
      signature_profile: "PADES_AD_RB",
      signer_name: "TRAJETTO SISTEMAS TESTE LTDA",
      signer_cnpj: "11222333000181",
    });
  });

  it("refuses to sign when the CMS does not fit the reserved placeholder", async () => {
    const service = new ProofSigningService(config({ signatureLength: 64 }));

    await expect(signedPdf(service)).rejects.toThrow(/exceeds placeholder/i);
  });
});

describe("a signed proof PDF (the model's plain CMS)", () => {
  it("uses adbe.pkcs7.detached with contentType, signingTime and messageDigest", async () => {
    const pdf = await signedPdf(
      new ProofSigningService(config({ profile: "CMS_DETACHED" })),
    );
    const { cms, covered } = extractSignature(pdf);
    const info = signerInfo(cms);

    expect(pdf.toString("latin1")).toContain("/SubFilter /adbe.pkcs7.detached");
    expect([...info.attributes.keys()].sort()).toEqual(
      [CMS_OID.contentType, CMS_OID.messageDigest, CMS_OID.signingTime].sort(),
    );

    const digest = Buffer.from(
      info.attributes.get(CMS_OID.messageDigest)!.value as string,
      "binary",
    );
    expect(digest.equals(createHash("sha256").update(covered).digest())).toBe(
      true,
    );
    expect(
      verifyRsa(
        info.attributesNode,
        info.signature,
        publicKeyDer(info.certificates[0]),
      ),
    ).toBe(true);
  });
});
