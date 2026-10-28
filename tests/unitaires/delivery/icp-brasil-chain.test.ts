import { describe, expect, it } from "vitest";

import forge from "node-forge";

import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildProofDocumentModel } from "@/shared/delivery/proof-document";
import { renderProofPdf } from "@/shared/services/proof-pdf-service";
import {
  officialIcpBrasilTrustStore,
  verifyIcpBrasilChain,
} from "@/shared/services/proof-signing/icp-brasil-chain";
import { ICP_BRASIL_ROOTS } from "@/shared/services/proof-signing/icp-brasil-roots";
import { ProofSigningService } from "@/shared/services/proof-signing/proof-signing-service";
import { loadSigningCertificate } from "@/shared/services/proof-signing/signing-certificate";

import { makeTestSigningCertificate } from "../../support/test-signing-certificate";

/**
 * Whether the proof may claim ICP-Brasil validity (meeting of 14/10/2026,
 * "item crítico").
 *
 * The loader used to decide it from the issuer's NAME: any certificate whose
 * issuer said "O=ICP-Brasil" printed the MP 2.200-2 statement, and writing
 * that name into a self-made certificate takes one openssl flag (the staging
 * one does). It is decided now by signatures, from the signer up to an
 * official root (AC Raiz v5/v10/v11). A certificate outside the chain still
 * signs — integrity is worth a signature — without the legal statement.
 */
const DAY = 24 * 60 * 60 * 1000;

const SOURCE = {
  delivery: {
    id: "018f0000-0000-7000-8000-0000000000e1",
    code: "PED-1",
    status: "DELIVERED" as const,
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

function service(certificate: {
  pfx: Buffer;
  password: string;
  trustStore?: X509Certificate[];
}): ProofSigningService {
  return new ProofSigningService({
    pfx: certificate.pfx,
    password: certificate.password,
    profile: "PADES_AD_RB",
    disabled: false,
    location: "Rio de Janeiro, RJ",
    contact: "suporte@trajetto.com.br",
    // Absent = the official ICP-Brasil roots.
    ...(certificate.trustStore && { trustStore: certificate.trustStore }),
  });
}

describe("the official ICP-Brasil roots", () => {
  // The embedded text must be the vendored file, and the file the ITI's:
  // a root edited by hand is a trust anchor nobody issued.
  it.each(ICP_BRASIL_ROOTS.map((root) => [root.name, root] as const))(
    "%s is the vendored file, with the documented fingerprint",
    (_name, root) => {
      const vendored = readFileSync(resolve(process.cwd(), root.file), "utf8");
      const certificate = new X509Certificate(root.pem);

      expect(root.pem.replace(/\r/g, "")).toBe(vendored.replace(/\r/g, ""));
      expect(certificate.fingerprint256.replace(/:/g, "").toLowerCase()).toBe(
        root.sha256,
      );
      expect(certificate.ca).toBe(true);
      expect(certificate.verify(certificate.publicKey)).toBe(true);
      expect(certificate.subject).toContain(`CN=${root.name}`);
      expect(certificate.subject).toContain("O=ICP-Brasil");
    },
  );

  it("are AC Raiz v5, v10 and v11, as published by the ITI", () => {
    expect(ICP_BRASIL_ROOTS.map((root) => root.sha256)).toEqual([
      "caa53fc6091c6951887c976e378f6ef89aa6377c55d97b6475422b71ed7e9b17",
      "6e0bff069a26994c15de2c4888cc54af84882e5495b7fbf66be9ccffec7489f6",
      "1406710058180fa4081aab3f246f1702429c552a11fa3143b84c88cb3ab8e5e7",
    ]);
    expect(officialIcpBrasilTrustStore()).toHaveLength(3);
  });
});

describe("a self-made certificate whose issuer says O=ICP-Brasil", () => {
  const certificate = makeTestSigningCertificate();

  it("loads READY, but is NOT ICP-Brasil against the official roots", () => {
    const state = loadSigningCertificate({
      pfx: certificate.pfx,
      password: certificate.password,
    });

    expect(state.state).toBe("READY");
    if (state.state !== "READY") return;

    expect(state.certificate.icpBrasil).toEqual({
      valid: false,
      reason: "UNTRUSTED_CHAIN",
    });
  });

  it("is signed without the legal statement, on the plain CMS, and recorded as outside the chain", () => {
    const plan = service(certificate).plan();

    expect(plan.status).toBe("SIGNED");
    if (plan.status !== "SIGNED") return;

    expect(plan.intent).toMatchObject({ status: "SIGNED", icpBrasil: false });
    // AD-RB names the ICP-Brasil policy inside the CMS: not claimed here.
    expect(plan.profile).toBe("CMS_DETACHED");
    expect(ProofSigningService.record(plan, new Date())).toMatchObject({
      signature_status: "SIGNED",
      signature_profile: "CMS_DETACHED",
      cert_icp_brasil: false,
    });

    const model = buildProofDocumentModel(SOURCE, {
      verificationBaseUrl: "https://app.trajetto.com.br",
      verificationToken: "ab".repeat(32),
      signing: plan.intent,
    });

    expect(model.signed).toBe(true);
    expect(model.icpBrasil).toBe(false);
    expect(model.legalLine).not.toContain("validade jurídica conforme");
    expect(model.authentication.qrUrl).not.toContain("validar.iti.gov.br");
  });

  it("still produces a signed PDF", async () => {
    const signing = service(certificate);
    const plan = signing.plan();

    if (plan.status !== "SIGNED") throw new Error("expected SIGNED");

    const model = buildProofDocumentModel(SOURCE, {
      verificationBaseUrl: "https://app.trajetto.com.br",
      verificationToken: "ab".repeat(32),
      signing: plan.intent,
    });
    const rendered = await renderProofPdf(
      model,
      { photo: null, signature: null },
      { signaturePlaceholder: plan.placeholder },
    );
    const pdf = (await signing.sign(rendered.bytes, plan)).toString("latin1");

    expect(pdf).toContain("/SubFilter /adbe.pkcs7.detached");
    expect(pdf).toMatch(/\/ByteRange \[\d+ \d+ \d+ \d+\s*\]/);
  });

  it("is not anchored by a forged issuer that copies the root's exact name", () => {
    // The issuer field equals AC Raiz v5's subject, byte for byte; the
    // signature is by another key, so the name alone anchors nothing.
    const v5 = new X509Certificate(ICP_BRASIL_ROOTS[0].pem);
    const rootName = forge.pki.certificateFromPem(ICP_BRASIL_ROOTS[0].pem)
      .subject.attributes;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const forged = forge.pki.createCertificate();
    forged.publicKey = forge.pki.publicKeyFromPem(publicKey);
    forged.serialNumber = "0badc0de";
    forged.validity.notBefore = new Date(Date.now() - DAY);
    forged.validity.notAfter = new Date(Date.now() + 365 * DAY);
    forged.setSubject([
      { shortName: "C", value: "BR" },
      { shortName: "O", value: "ICP-Brasil" },
      { shortName: "CN", value: "EMPRESA FALSA:11222333000181" },
    ]);
    forged.setIssuer(rootName);
    forged.setExtensions([{ name: "basicConstraints", cA: false }]);
    forged.sign(
      forge.pki.privateKeyFromPem(privateKey),
      forge.md.sha256.create(),
    );

    const leaf = Buffer.from(
      forge.asn1.toDer(forge.pki.certificateToAsn1(forged)).getBytes(),
      "binary",
    );

    expect(new X509Certificate(leaf).issuer).toBe(v5.subject);
    expect(verifyIcpBrasilChain({ leaf, intermediates: [] })).toEqual({
      valid: false,
      reason: "UNTRUSTED_CHAIN",
    });
  });
});

describe("a chain of signatures up to a trusted root", () => {
  it("is ICP-Brasil through the PFX's intermediate", () => {
    const certificate = makeTestSigningCertificate({ chain: "test-root" });
    const state = loadSigningCertificate({
      pfx: certificate.pfx,
      password: certificate.password,
      trustStore: certificate.trustStore,
    });

    expect(state.state).toBe("READY");
    if (state.state !== "READY") return;

    expect(state.certificate.icpBrasil).toMatchObject({
      valid: true,
      root: "AC Raiz de Teste do Trajetto",
    });

    const plan = service(certificate).plan();

    expect(plan).toMatchObject({
      status: "SIGNED",
      profile: "PADES_AD_RB",
      intent: { icpBrasil: true },
    });
  });

  it("is not ICP-Brasil against the official roots, whatever its names say", () => {
    const certificate = makeTestSigningCertificate({ chain: "test-root" });

    expect(
      service({ pfx: certificate.pfx, password: certificate.password }).plan(),
    ).toMatchObject({ status: "SIGNED", intent: { icpBrasil: false } });
  });

  it("does not reach the root when the PFX lacks the intermediate", () => {
    const certificate = makeTestSigningCertificate({
      chain: "test-root",
      omitIntermediate: true,
    });
    const state = loadSigningCertificate({
      pfx: certificate.pfx,
      password: certificate.password,
      trustStore: certificate.trustStore,
    });

    expect(state.state === "READY" && state.certificate.icpBrasil).toEqual({
      valid: false,
      reason: "UNTRUSTED_CHAIN",
    });
  });

  it("stops being ICP-Brasil when its intermediate lapses, while the signer still signs", () => {
    const certificate = makeTestSigningCertificate({
      chain: "test-root",
      intermediateNotAfter: new Date(Date.now() + 10 * DAY),
    });
    const signing = service(certificate);

    expect(signing.plan()).toMatchObject({ intent: { icpBrasil: true } });

    const later = new Date(Date.now() + 11 * DAY);

    expect(signing.plan(later)).toMatchObject({
      status: "SIGNED",
      profile: "CMS_DETACHED",
      intent: { icpBrasil: false },
    });
  });

  it("refuses a CA certificate as the signer", () => {
    const v5 = new X509Certificate(ICP_BRASIL_ROOTS[0].pem);

    expect(verifyIcpBrasilChain({ leaf: v5.raw, intermediates: [] })).toEqual({
      valid: false,
      reason: "LEAF_IS_CA",
    });
  });
});
