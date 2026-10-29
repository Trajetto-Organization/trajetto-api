import { X509Certificate } from "node:crypto";

import { ICP_BRASIL_ROOTS } from "./icp-brasil-roots";

/**
 * Does the platform certificate really belong to ICP-Brasil? (meeting of
 * 14/10/2026, "item crítico").
 *
 * The loader used to answer from the issuer's NAME: any certificate whose
 * issuer said "O=ICP-Brasil" printed the legal-validity statement of MP
 * 2.200-2 — and anyone can write that name into a self-made certificate (the
 * staging one does, on purpose). The answer now comes from signatures: from
 * the signer's certificate, through the intermediates the PFX carries, up to
 * one of the official roots (icp-brasil-roots.ts), each link's signature
 * verified with the issuer's public key and each certificate inside its
 * validity window. A certificate that only claims the name does not verify
 * against the ITI's keys.
 *
 * What this does NOT check, on purpose and written down: revocation (the
 * ICP-Brasil LCRs would need a network fetch per boot and a cache), the
 * certificate policy OIDs, and name or path-length constraints. The ITI's
 * validator does all of them on the file itself; this check only decides
 * whether OUR text may claim what that validator is expected to confirm.
 */

type IcpChainFailure =
  /** A certificate in the PFX could not be parsed. */
  | "UNREADABLE"
  /** The signer's certificate is a CA's, not an end entity's. */
  | "LEAF_IS_CA"
  /** No chain of verified signatures reaches a trusted root. */
  | "UNTRUSTED_CHAIN"
  /** The chain exists, but a certificate on it is outside its validity. */
  | "OUTSIDE_VALIDITY";

type IcpChainVerdict =
  | {
      valid: true;
      /** The root's CN, e.g. "Autoridade Certificadora Raiz Brasileira v5". */
      root: string;
      /** The chain holds while every certificate on it does. */
      validFrom: Date;
      validUntil: Date;
    }
  | { valid: false; reason: IcpChainFailure };

/** The trust anchors: the official roots, or a test's own. */
type IcpTrustStore = readonly X509Certificate[];

/** Roots, intermediates and the signer: no ICP-Brasil chain is longer. */
const MAX_CHAIN_LENGTH = 6;

let officialStore: IcpTrustStore | null = null;

/** The official roots, parsed once per process. */
function officialIcpBrasilTrustStore(): IcpTrustStore {
  officialStore ??= ICP_BRASIL_ROOTS.map(
    (root) => new X509Certificate(root.pem),
  );

  return officialStore;
}

function parse(der: Buffer): X509Certificate | null {
  try {
    return new X509Certificate(der);
  } catch {
    return null;
  }
}

/**
 * Whether `issuer` signed `child`: the names (and key identifiers) match AND
 * the signature verifies with the issuer's key. The first half alone is what
 * the old name check amounted to.
 */
function issuedBy(child: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return child.checkIssued(issuer) && child.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

function sameCertificate(a: X509Certificate, b: X509Certificate): boolean {
  return a.fingerprint256 === b.fingerprint256;
}

/**
 * Walks from the signer's certificate to a trusted root through the PFX's
 * intermediates. Never throws: a broken certificate is a verdict, not a
 * crash of the boot that loads it.
 */
function verifyIcpBrasilChain(input: {
  /** DER of the signer's certificate. */
  leaf: Buffer;
  /** The other certificates the PFX carried, DER, in any order. */
  intermediates: readonly Buffer[];
  /** Defaults to the official ICP-Brasil roots. */
  trustStore?: IcpTrustStore;
  /**
   * When given, a chain outside its validity at this instant is refused.
   * The loader leaves it out: the PFX is opened once per process, and
   * isIcpBrasilAt re-reads the window on every document.
   */
  now?: Date;
}): IcpChainVerdict {
  const roots = input.trustStore ?? officialIcpBrasilTrustStore();
  const { now } = input;

  const leaf = parse(input.leaf);

  if (!leaf) return { valid: false, reason: "UNREADABLE" };

  // A CA certificate signing documents is not what ICP-Brasil issues for it.
  if (leaf.ca) return { valid: false, reason: "LEAF_IS_CA" };

  // An unreadable intermediate is skipped, not fatal: the chain may not need
  // it, and when it does the walk below ends without a root.
  const pool = input.intermediates
    .map(parse)
    .filter((cert): cert is X509Certificate => cert !== null && cert.ca);

  const path: X509Certificate[] = [leaf];
  let current = leaf;

  while (path.length <= MAX_CHAIN_LENGTH) {
    // Anchors only ever come from the trust store: a "root" carried in the
    // PFX is trusted only if it IS one of them (same key, same signature).
    const anchor = roots.find((root) => issuedBy(current, root));

    if (anchor) {
      if (!sameCertificate(current, anchor)) path.push(anchor);

      return withinValidity(path, anchor, now);
    }

    const next = pool.find(
      (candidate) =>
        !path.some((seen) => sameCertificate(seen, candidate)) &&
        issuedBy(current, candidate),
    );

    if (!next) return { valid: false, reason: "UNTRUSTED_CHAIN" };

    path.push(next);
    current = next;
  }

  return { valid: false, reason: "UNTRUSTED_CHAIN" };
}

function withinValidity(
  path: readonly X509Certificate[],
  anchor: X509Certificate,
  now: Date | undefined,
): IcpChainVerdict {
  const validFrom = new Date(
    Math.max(...path.map((cert) => new Date(cert.validFrom).getTime())),
  );
  const validUntil = new Date(
    Math.min(...path.map((cert) => new Date(cert.validTo).getTime())),
  );

  if (now && (now < validFrom || now > validUntil)) {
    return { valid: false, reason: "OUTSIDE_VALIDITY" };
  }

  const root =
    anchor.subject
      .split("\n")
      .find((line) => line.startsWith("CN="))
      ?.slice(3) ?? anchor.subject;

  return { valid: true, root, validFrom, validUntil };
}

/**
 * Whether the verdict still holds at `now`: a long-lived process outlives
 * the day an intermediate (or the root) lapses, as it outlives the A1's.
 */
function isIcpBrasilAt(verdict: IcpChainVerdict, now: Date): boolean {
  return (
    verdict.valid &&
    now.getTime() >= verdict.validFrom.getTime() &&
    now.getTime() <= verdict.validUntil.getTime()
  );
}

export {
  isIcpBrasilAt,
  officialIcpBrasilTrustStore,
  verifyIcpBrasilChain,
  type IcpChainFailure,
  type IcpChainVerdict,
  type IcpTrustStore,
};
