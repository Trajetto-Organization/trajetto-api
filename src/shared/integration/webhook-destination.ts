import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Where a webhook may and may not be delivered.
 *
 * A customer registers the URL of their own system and our server does the
 * POST. That is, literally, "ask your server to fetch this address" — and with
 * no brake, the address can be THE PLATFORM's internal network. An
 * administrator at any carrier could point an endpoint at `169.254.169.254`
 * and read the instance credentials, or sweep internal ports by timing the
 * responses.
 *
 * What closes the hole, and why each piece is needed:
 *
 * - Resolve the name and look at the IP, not at the text.
 *   `https://internal.example.com` can point at 10.0.0.5, and a list of
 *   forbidden names never reaches that.
 * - Check ON EVERY SEND, not only at registration. A name that resolved to a
 *   public address when it was saved can start resolving to a private one
 *   later — that is DNS rebinding, and validating only on write is exactly
 *   what it walks around.
 * - Refuse on ALL of the name's addresses, not the first. A name with a public
 *   A record and an AAAA on `::1` would pass any check that looked at one.
 * - Do not follow redirects. The `https://` from registration only covers the
 *   first hop; a 302 to `http://169.254.169.254` voids the whole rule. A
 *   webhook receiver has no legitimate reason to redirect.
 */
interface DestinationVerdict {
  allowed: boolean;

  /** The sentence the monitor shows. Never the IP — see below. */
  reason?: string;
}

/**
 * Ranges that are never a customer.
 *
 * Written as numeric comparisons rather than a regex over text: `010.0.0.5`,
 * `0x0A000005` and `167772161` are all 10.0.0.5 to the resolver, and a
 * `startsWith("10.")` sees none of them.
 */
function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }

  const [a, b] = parts;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;

  // Cloud metadata and the rest of link-local.
  if (a === 169 && b === 254) return true;

  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;

  // Carrier-grade NAT and the benchmarking range.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;

  // Multicast and reserved.
  if (a >= 224) return true;

  return false;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0];

  if (value === "::1" || value === "::") return true;

  // Link-local, unique-local and multicast.
  if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) {
    return true;
  }

  if (value.startsWith("ff")) return true;

  // Mapped IPv4: `::ffff:10.0.0.5` is 10.0.0.5 wearing another coat.
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);

  return true;
}

/**
 * Names that are never a customer, even when they resolve to a public address.
 *
 * The IP check is the one that decides; this one catches the case where
 * resolution fails or is intercepted, and says the right thing in the monitor.
 */
const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".cluster.local",
];

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

function hasBlockedName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (BLOCKED_HOSTS.has(host)) return true;

  return BLOCKED_HOST_SUFFIXES.some(
    (suffix) => host === suffix.replace(/^\./, "") || host.endsWith(suffix),
  );
}

/**
 * Decides whether this send may leave.
 *
 * The refusal sentence never includes the resolved address. The monitor is
 * visible to the customer themselves, and answering "10.0.0.5 is private"
 * turns the error message into the very port-scanning oracle this check exists
 * to prevent.
 */
async function verifyWebhookDestination(
  url: string,
): Promise<DestinationVerdict> {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch (error) {
    return { allowed: false, reason: "A URL do endpoint é inválida." };
  }

  // On the way out as well, not only at registration: a row saved before this
  // rule existed would otherwise stay valid forever.
  if (parsed.protocol !== "https:") {
    return {
      allowed: false,
      reason: "O endpoint precisa ser https.",
    };
  }

  if (hasBlockedName(parsed.hostname)) {
    return {
      allowed: false,
      reason: "O endpoint precisa ser um endereço alcançável pela internet.",
    };
  }

  // A literal is already the answer; there is nothing to resolve.
  if (isIP(parsed.hostname)) {
    return isPrivateAddress(parsed.hostname)
      ? {
          allowed: false,
          reason: "O endpoint precisa ser um endereço alcançável pela internet.",
        }
      : { allowed: true };
  }

  let addresses: Array<{ address: string }>;

  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch (error) {
    return {
      allowed: false,
      reason: "Não foi possível resolver o endereço do endpoint.",
    };
  }

  if (addresses.length === 0) {
    return {
      allowed: false,
      reason: "Não foi possível resolver o endereço do endpoint.",
    };
  }

  // ALL of them, not the first: a name with a public A record and an AAAA on
  // `::1` would pass any check that looked at one.
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    return {
      allowed: false,
      reason: "O endpoint precisa ser um endereço alcançável pela internet.",
    };
  }

  return { allowed: true };
}

/**
 * Headers the customer may not write.
 *
 * The customer's map exists for the authentication THEIR gateway requires.
 * What it may not do is overwrite ours: the signature is the guarantee the
 * public documentation promises, and a customer who replaces it with any value
 * they like turns a shared receiver into a replay target. `Host`,
 * `Content-Length` and the like change WHERE and HOW the request goes — which
 * is exactly what the destination check just finished deciding.
 */
const RESERVED_WEBHOOK_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "user-agent",
  "x-trajetto-topic",
  "x-trajetto-delivery",
  "x-trajetto-signature",
]);

function reservedHeaderNames(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter((name) =>
    RESERVED_WEBHOOK_HEADERS.has(name.trim().toLowerCase()),
  );
}

/** The customer's map, without what they may not write. */
function safeWebhookHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!headers) return {};

  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !RESERVED_WEBHOOK_HEADERS.has(name.trim().toLowerCase()),
    ),
  );
}

export {
  RESERVED_WEBHOOK_HEADERS,
  hasBlockedName,
  isPrivateAddress,
  reservedHeaderNames,
  safeWebhookHeaders,
  verifyWebhookDestination,
  type DestinationVerdict,
};
