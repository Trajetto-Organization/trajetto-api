import { ProofLocationService } from "@/shared/services/proof-location/proof-location-service";
import {
  ProofSigningService,
  type ProofSigningConfig,
} from "@/shared/services/proof-signing/proof-signing-service";

import { makeTestSigningCertificate } from "./test-signing-certificate";

/**
 * The proof document's two collaborators, built for real with a test
 * configuration (decision 14.8): no certificate (documents go out unsigned,
 * reason NO_CERTIFICATE), or one generated in the test; and no geocoder or
 * map provider, so nothing leaves the process.
 *
 * The generated certificate chains to a test root that the service is told
 * to trust in place of the official ICP-Brasil roots, so these documents
 * take the ICP-Brasil path (AD-RB, the legal wording). A test about a
 * certificate OUTSIDE the chain says so: `selfSignedCertificateSigning`.
 */
function unsignedSigning(): ProofSigningService {
  return new ProofSigningService({
    pfx: null,
    password: undefined,
    profile: "PADES_AD_RB",
    disabled: false,
    location: "",
    contact: "",
  });
}

function testCertificateSigning(
  overrides: Partial<ProofSigningConfig> = {},
): ProofSigningService {
  const certificate = makeTestSigningCertificate({ chain: "test-root" });

  return new ProofSigningService({
    pfx: certificate.pfx,
    password: certificate.password,
    profile: "PADES_AD_RB",
    disabled: false,
    location: "Rio de Janeiro, RJ",
    contact: "suporte@trajetto.com.br",
    trustStore: certificate.trustStore,
    ...overrides,
  });
}

/**
 * A certificate that only SAYS "O=ICP-Brasil" (self-signed), against the
 * official roots: signed, never ICP-Brasil.
 */
function selfSignedCertificateSigning(
  overrides: Partial<ProofSigningConfig> = {},
): ProofSigningService {
  const certificate = makeTestSigningCertificate();

  return new ProofSigningService({
    pfx: certificate.pfx,
    password: certificate.password,
    profile: "PADES_AD_RB",
    disabled: false,
    location: "Rio de Janeiro, RJ",
    contact: "suporte@trajetto.com.br",
    ...overrides,
  });
}

function noLocationProviders(): ProofLocationService {
  return new ProofLocationService({
    geocoder: {
      url: undefined,
      key: undefined,
      keyParam: "key",
      userAgent: "Trajetto/test",
      timeoutMs: 100,
    },
    map: { template: undefined, attribution: undefined, timeoutMs: 100 },
  });
}

export {
  noLocationProviders,
  selfSignedCertificateSigning,
  testCertificateSigning,
  unsignedSigning,
};
