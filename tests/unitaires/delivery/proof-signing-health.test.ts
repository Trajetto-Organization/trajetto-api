import { describe, expect, it } from "vitest";

import {
  ProofSigningService,
  type ProofSigningConfig,
} from "@/shared/services/proof-signing/proof-signing-service";

import { makeTestSigningCertificate } from "../../support/test-signing-certificate";

/**
 * What /health/metrics and the ops heartbeat read about the proof signing
 * certificate (design §6.3/§7.4): the state and its dates, never the key,
 * the password, the serial or the CNPJ.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();

function config(overrides: Partial<ProofSigningConfig> = {}): ProofSigningConfig {
  const certificate = makeTestSigningCertificate({
    notAfter: new Date(NOW.getTime() + 20 * DAY + 60_000),
  });

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

describe("the proof signing health summary", () => {
  it("gives the state, the profile and the days left of a READY certificate", () => {
    const health = new ProofSigningService(config()).health(NOW);

    expect(health).toMatchObject({
      state: "READY",
      reason: null,
      profile: "PADES_AD_RB",
      signer_name: "TRAJETTO SISTEMAS TESTE LTDA",
      days_left: 20,
    });
    expect(new Date(health.not_after as string).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("never carries the serial, the CNPJ or anything of the key", () => {
    const certificate = makeTestSigningCertificate();
    const text = JSON.stringify(
      new ProofSigningService(config({ pfx: certificate.pfx, password: certificate.password })).health(NOW),
    );

    expect(text).not.toContain(certificate.serialHex);
    expect(text).not.toContain("11222333000181");
    expect(text).not.toContain(certificate.password);
  });

  it("reports ABSENT and DISABLED without dates", () => {
    expect(new ProofSigningService(config({ pfx: null })).health(NOW)).toEqual({
      state: "ABSENT",
      reason: null,
      profile: null,
      signer_name: null,
      not_after: null,
      days_left: null,
    });
    expect(new ProofSigningService(config({ disabled: true })).health(NOW).state).toBe("DISABLED");
  });

  it("gives the reason of an INVALID certificate", () => {
    const health = new ProofSigningService(config({ password: "errada" })).health(NOW);

    expect(health).toMatchObject({ state: "INVALID", reason: "PFX_UNREADABLE", not_after: null });
  });
});
