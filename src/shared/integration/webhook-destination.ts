import { Resolver } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

import { Agent } from "undici";

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
 * - Connect to the address that was checked. The fetch used to resolve the
 *   name again, on its own: a name with TTL 0 answered public to the check
 *   and private to the connection (DNS rebinding). `webhookAgent` resolves at
 *   connect time, refuses a private answer and hands the socket the address
 *   it validated — the connection cannot go anywhere the check did not see.
 */
interface DestinationVerdict {
  allowed: boolean;

  /** Refused for now, not for good: the name could not be resolved. */
  transient?: boolean;

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

/**
 * An IPv6 address as its eight 16-bit groups, or null when it is not one.
 *
 * Numbers, for the same reason as the IPv4 check: the text has too many
 * spellings. `fe90::1` is link-local although it does not start with "fe80",
 * and `::a00:5`, `::10.0.0.5` and `0:0:0:0:0:0:a00:5` are the same address.
 */
function expandIPv6(address: string): number[] | null {
  let value = address.toLowerCase().split("%")[0];

  // A trailing dotted quad is two groups written another way.
  const dotted = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);

  if (dotted) {
    const octets = dotted[2].split(".").map(Number);

    if (octets.some((octet) => octet > 255)) return null;

    value =
      dotted[1] +
      ((octets[0] << 8) | octets[1]).toString(16) +
      ":" +
      ((octets[2] << 8) | octets[3]).toString(16);
  }

  const halves = value.split("::");

  if (halves.length > 2) return null;

  const parse = (text: string) => (text === "" ? [] : text.split(":"));

  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];

  const missing = 8 - head.length - tail.length;

  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];

  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  return groups.map((group) => parseInt(group, 16));
}

/** The IPv4 carried in two groups: `0a00:0005` is 10.0.0.5. */
function embeddedIPv4(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateIPv6(address: string): boolean {
  const h = expandIPv6(address);

  // When in doubt, nothing leaves.
  if (!h) return true;

  const zeros = (from: number, to: number) =>
    h.slice(from, to).every((group) => group === 0);

  // ::/96 — unspecified, loopback and the deprecated IPv4-compatible form
  // (`::127.0.0.1`). None of them is a customer.
  if (zeros(0, 6)) return true;

  // Mapped (`::ffff:10.0.0.5`) and translated (`::ffff:0:10.0.0.5`): an IPv4
  // wearing another coat, judged as the IPv4 it is.
  if (zeros(0, 5) && h[5] === 0xffff)
    return isPrivateIPv4(embeddedIPv4(h[6], h[7]));
  if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) {
    return isPrivateIPv4(embeddedIPv4(h[6], h[7]));
  }

  // NAT64, 64:ff9b::/96. Judged by the IPv4 it embeds and not refused
  // outright: DNS64 legitimately synthesises it for every public IPv4 host.
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) {
    return isPrivateIPv4(embeddedIPv4(h[6], h[7]));
  }

  // Local-use NAT64, 64:ff9b:1::/48 — translated inside somebody's network.
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true;

  // 6to4, 2002::/16: the IPv4 sits in the second and third groups.
  if (h[0] === 0x2002) return isPrivateIPv4(embeddedIPv4(h[1], h[2]));

  // Teredo (2001::/32) tunnels to an address we cannot see; documentation
  // (2001:db8::/32) is never a host.
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0x0db8)) return true;

  // Discard-only, 100::/64.
  if (h[0] === 0x0100 && zeros(1, 4)) return true;

  // Unique-local fc00::/7, link-local fe80::/10, the deprecated site-local
  // fec0::/10 and multicast ff00::/8.
  if ((h[0] & 0xfe00) === 0xfc00) return true;
  if ((h[0] & 0xffc0) === 0xfe80) return true;
  if ((h[0] & 0xffc0) === 0xfec0) return true;
  if ((h[0] & 0xff00) === 0xff00) return true;

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

/** The sentence for a destination that is refused for good. */
const UNREACHABLE_REASON =
  "O endpoint precisa ser um endereço alcançável pela internet.";

const UNRESOLVED_REASON = "Não foi possível resolver o endereço do endpoint.";

/**
 * How long one name may take to resolve.
 *
 * c-ares (`Resolver`), not `dns.lookup`: getaddrinfo runs on libuv's
 * four-thread pool — shared with bcrypt on every login — and has no timeout of
 * its own, so a customer's authoritative server that never answers held a
 * thread for as long as the system resolver cared to wait. c-ares queries run
 * on the event loop. The budget caps the whole resolution, whatever the number
 * of nameservers c-ares walks through.
 */
const DNS_QUERY_TIMEOUT_MS = 2_000;
const DNS_BUDGET_MS = 2_500;

const resolver = new Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: 1 });

type ResolveHost = (hostname: string) => Promise<string[]>;

function webhookDnsError(
  code: "EWEBHOOK_UNRESOLVED" | "EWEBHOOK_FORBIDDEN",
  message: string,
): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/**
 * Every address of a name, A and AAAA, within the budget.
 *
 * Whatever answered in time counts: a name whose AAAA query hangs still
 * resolves by its A record. No answer at all is `EWEBHOOK_UNRESOLVED` — a
 * transient failure, never a verdict on where the name points.
 */
async function resolveHost(hostname: string): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), DNS_BUDGET_MS);
  });

  try {
    const answers = await Promise.all(
      [resolver.resolve4(hostname), resolver.resolve6(hostname)].map((query) =>
        Promise.race([query.catch((): string[] => []), deadline]),
      ),
    );

    const addresses = answers.flat();

    if (addresses.length === 0) {
      throw webhookDnsError("EWEBHOOK_UNRESOLVED", UNRESOLVED_REASON);
    }

    return addresses;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A `dns.lookup` for the webhook socket: resolves once, refuses a private
 * answer, and hands the socket exactly the addresses it validated.
 *
 * This is what closes DNS rebinding. The check before the send still runs —
 * it gives the monitor its sentences — but it is this lookup, at connect time,
 * that decides where the bytes go. An IP literal never reaches it (the socket
 * skips the lookup), and a literal is judged by the check.
 */
function createGuardedLookup(
  resolve: ResolveHost = resolveHost,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        // ALL of them: a public A record next to an AAAA on `::1` is refused.
        if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
          callback(
            addresses.length === 0
              ? webhookDnsError("EWEBHOOK_UNRESOLVED", UNRESOLVED_REASON)
              : webhookDnsError("EWEBHOOK_FORBIDDEN", UNREACHABLE_REASON),
            "",
          );

          return;
        }

        const wanted =
          options.family === 4 || options.family === "IPv4"
            ? 4
            : options.family === 6 || options.family === "IPv6"
              ? 6
              : 0;

        const entries = addresses
          .map((address) => ({ address, family: isIP(address) }))
          .filter((entry) => wanted === 0 || entry.family === wanted);

        if (entries.length === 0) {
          callback(
            webhookDnsError("EWEBHOOK_UNRESOLVED", UNRESOLVED_REASON),
            "",
          );
          return;
        }

        if (options.all) {
          callback(null, entries);
          return;
        }

        callback(null, entries[0].address, entries[0].family);
      },
      () =>
        callback(webhookDnsError("EWEBHOOK_UNRESOLVED", UNRESOLVED_REASON), ""),
    );
  };
}

/**
 * The HTTP client every webhook goes through: connections are made only to
 * addresses `createGuardedLookup` validated, with a connect timeout of their
 * own. Used with undici's own `fetch` — Node's global fetch bundles a
 * different undici, and a dispatcher from one is not a dispatcher of the
 * other.
 */
function createWebhookAgent(resolve: ResolveHost = resolveHost): Agent {
  return new Agent({
    connect: { lookup: createGuardedLookup(resolve), timeout: 5_000 },
  });
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
  resolve: ResolveHost = resolveHost,
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

  // The HTTP client refuses to build a request from a URL with credentials in
  // it, so every attempt threw, was counted as a network blip and retried
  // until the breaker tripped. It can never work: refused for good, saying so.
  if (parsed.username || parsed.password) {
    return {
      allowed: false,
      reason: USERINFO_REFUSAL,
    };
  }

  // `hostname` keeps the brackets of an IPv6 literal. `isIP("[::1]")` is 0,
  // so the literal went to the resolver — which Linux cannot resolve, and
  // every event failed as "transient" until the endpoint was switched off.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");

  if (hasBlockedName(host)) {
    return {
      allowed: false,
      reason: "O endpoint precisa ser um endereço alcançável pela internet.",
    };
  }

  // A literal is already the answer; there is nothing to resolve.
  if (isIP(host)) {
    return isPrivateAddress(host)
      ? {
          allowed: false,
          reason:
            "O endpoint precisa ser um endereço alcançável pela internet.",
        }
      : { allowed: true };
  }

  let addresses: string[];

  // A lookup that FAILED says nothing about where the name points — a DNS
  // timeout, a resolver restart. It used to be refused like a private address:
  // the delivery failed for good and the endpoint was switched off, so one
  // DNS blip silently stopped a customer's integration. It is `transient` now:
  // retried on the schedule like any other network failure.
  try {
    addresses = await resolve(host);
  } catch (error) {
    return {
      allowed: false,
      transient: true,
      reason: "Não foi possível resolver o endereço do endpoint.",
    };
  }

  if (addresses.length === 0) {
    return {
      allowed: false,
      transient: true,
      reason: "Não foi possível resolver o endereço do endpoint.",
    };
  }

  // ALL of them, not the first: a name with a public A record and an AAAA on
  // `::1` would pass any check that looked at one.
  if (addresses.some(isPrivateAddress)) {
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

  // Hop-by-hop, or refused outright by the HTTP client: a request carrying
  // one of these throws before it leaves, every time.
  "keep-alive",
  "expect",
  "te",
  "trailer",

  // Ours: we send `identity`, and a second value would be joined to it.
  "accept-encoding",

  "x-trajetto-topic",
  "x-trajetto-event-id",
  "x-trajetto-delivery",
  "x-trajetto-signature",
]);

/** Also every `Proxy-*` (hop-by-hop) and every `X-Trajetto-*` (our namespace). */
function isReservedHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();

  return (
    RESERVED_WEBHOOK_HEADERS.has(normalized) ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("x-trajetto-")
  );
}

/**
 * What an HTTP request can carry at all: a name that is an RFC 9110 token, a
 * value of visible bytes, spaces and tabs. Anything else — a line break above
 * all — makes the client throw before the request leaves.
 */
const SENDABLE_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SENDABLE_HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** What we accept at registration, on top of being sendable. */
const HEADER_NAME_MAX_LENGTH = 64;
const HEADER_VALUE_MAX_LENGTH = 1024;

const USERINFO_REFUSAL =
  "A URL do endpoint não pode conter usuário e senha; use um cabeçalho de autenticação.";

function isSendableHeader(name: string, value: unknown): boolean {
  return (
    SENDABLE_HEADER_NAME.test(name) &&
    typeof value === "string" &&
    SENDABLE_HEADER_VALUE.test(value)
  );
}

function reservedHeaderNames(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter(isReservedHeader);
}

/** The names a registration must refuse: not sendable, or past the limits. */
function invalidHeaderEntries(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(
      ([name, value]) =>
        !isSendableHeader(name, value) ||
        name.length > HEADER_NAME_MAX_LENGTH ||
        value.length > HEADER_VALUE_MAX_LENGTH,
    )
    .map(([name]) => name);
}

/**
 * The customer's map, without what they may not write and without what could
 * never be sent. The second half protects rows saved before the registration
 * rules: one unsendable header made every attempt of that endpoint fail. The
 * registration limits are not applied here — a long header that works today
 * keeps working.
 */
function safeWebhookHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!headers) return {};

  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) =>
        !isReservedHeader(name) && isSendableHeader(name, value),
    ),
  );
}

/** The longest endpoint URL accepted: what every mainstream browser accepts. */
const WEBHOOK_URL_MAX_LENGTH = 2048;

/**
 * A host that can be judged without DNS and is never reachable: a literal
 * private/loopback address, or a blocked name (`localhost`, `*.internal`).
 *
 * Checked when the endpoint is SAVED, so the person is told at once instead
 * of every send failing until the breaker trips. It is only the part that
 * needs no lookup: a public name resolving to a private address is still
 * refused on every send by verifyWebhookDestination (DNS can change).
 */
function hasUnreachableLiteralHost(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");

  if (hasBlockedName(host)) return true;

  return isIP(host) !== 0 && isPrivateAddress(host);
}

/** A URL carrying `user:password@`, which no request can be built from. */
function hasUserInfo(url: string): boolean {
  try {
    const parsed = new URL(url);

    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

export {
  HEADER_NAME_MAX_LENGTH,
  HEADER_VALUE_MAX_LENGTH,
  RESERVED_WEBHOOK_HEADERS,
  UNREACHABLE_REASON,
  UNRESOLVED_REASON,
  USERINFO_REFUSAL,
  WEBHOOK_URL_MAX_LENGTH,
  createGuardedLookup,
  createWebhookAgent,
  hasBlockedName,
  hasUnreachableLiteralHost,
  hasUserInfo,
  invalidHeaderEntries,
  isPrivateAddress,
  isReservedHeader,
  reservedHeaderNames,
  resolveHost,
  safeWebhookHeaders,
  verifyWebhookDestination,
  type DestinationVerdict,
  type ResolveHost,
};
