import { timingSafeEqual } from "node:crypto";

/**
 * Who may read the INTERNAL reference.
 *
 * Outside production, everybody: that document is the whole point of running
 * the API locally. In production it is a complete map of the product —
 * every master-only endpoint, every schema, every error code — and a map is
 * the first thing anybody attacking a system tries to obtain.
 *
 * Basic auth rather than a session, because the people who read it are not
 * always users of the product: an integrator's engineer, somebody debugging a
 * deploy. A shared credential handed out deliberately is the honest shape of
 * that, and it is off unless both halves are set.
 */
interface DocsCredentials {
  user?: string;
  password?: string;
}

type DocsAccess =
  | { kind: "open" }
  | { kind: "disabled"; reason?: "weak-password" }
  | { kind: "basic"; user: string; password: string };

/**
 * The shortest password that opens the map.
 *
 * A shared credential typed by people is the kind that ends up short, and the
 * routes behind it are the product's full reference. Twenty characters puts
 * guessing out of reach even at the global rate limit.
 */
const DOCS_PASSWORD_MIN_LENGTH = 20;

function docsAccessFor(
  nodeEnv: string,
  credentials: DocsCredentials,
): DocsAccess {
  if (nodeEnv !== "production") return { kind: "open" };

  const { user, password } = credentials;

  // Both halves or neither. A username with no password is somebody who
  // half-configured this, and opening the document on a half-configuration is
  // exactly the accident the gate exists to prevent.
  if (!user || !password) return { kind: "disabled" };

  // Closed, not open on a weak one — and not a failed boot either: a docs
  // password is not worth taking the API down over. The boot logs why.
  if (password.length < DOCS_PASSWORD_MIN_LENGTH) {
    return { kind: "disabled", reason: "weak-password" };
  }

  return { kind: "basic", user, password };
}

/** Constant-time on both halves, so a wrong username leaks no timing either. */
function basicAuthMatches(
  header: string | undefined,
  expected: { user: string; password: string },
): boolean {
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;

  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch (error) {
    return false;
  }

  const separator = decoded.indexOf(":");

  if (separator === -1) return false;

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  return (
    constantTimeEquals(user, expected.user) &&
    constantTimeEquals(password, expected.password)
  );
}

/**
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing signal — so both sides are hashed to a fixed width first by padding
 * through a comparison of equal-length buffers.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");

  if (a.length !== b.length) {
    // Still burn a comparison of the right size, so the answer to "was the
    // length right?" costs the same as the answer to "was the value right?".
    timingSafeEqual(b, b);

    return false;
  }

  return timingSafeEqual(a, b);
}

export {
  DOCS_PASSWORD_MIN_LENGTH,
  basicAuthMatches,
  docsAccessFor,
  type DocsAccess,
};
