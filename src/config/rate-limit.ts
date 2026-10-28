import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { FastifyRequest } from "fastify";
import { verify } from "jsonwebtoken";

import auth from "@/config/auth";
import { isCloudflareEdge } from "@/config/trusted-edge";
import { env } from "@/env";
import { AppError } from "@/shared/errors/AppError";
import { hmacVerifyKey } from "@/shared/security/jwt-verify-key";

/**
 * The single key and the single refusal for every rate limiter in the app.
 *
 * There used to be two of each — one inline in http.ts for the global limit and
 * one in the per-route helper — and they disagreed on both counts.
 */

/**
 * Which header, if any, says where the request came from.
 *
 * - `none`: the socket address only. Right with no proxy in front; behind one
 *   it puts the whole internet in one bucket, and one attacker turns the login
 *   limit into a denial of service for everybody.
 * - `xff`: `X-Forwarded-For`, reading the LAST entry. A trusted proxy APPENDS
 *   the peer's address; whatever the client wrote comes before it. Right for
 *   Traefik and nginx.
 * - `cloudflare`: `CF-Connecting-IP`, which Cloudflare OVERWRITES.
 *
 * `cloudflare` is VERIFIED: the header counts only when the peer our proxy saw
 * (the last X-Forwarded-For entry, or the socket without one) is a Cloudflare
 * edge (see trusted-edge.ts), and, when RATE_LIMIT_EDGE_SECRET is set, only
 * next to the header our own zone adds. Anything else is keyed by that peer,
 * which is exactly what `xff` does — so a caller who reaches the origin on its
 * own IP and writes the header gets their own address, not a bucket of their
 * choosing. Production sits behind Cloudflare, where `xff` keys every user by
 * the edge that served them: thousands of people in one login bucket.
 */
type TrustedProxyMode = "none" | "xff" | "cloudflare";

/**
 * The last hop, never the first: the first `X-Forwarded-For` value is what the
 * CLIENT wrote (a fresh bucket per request for an attacker); the trusted proxy
 * appends the real address at the end.
 */
function lastForwardedAddress(
  value: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;

  if (!raw) return null;

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * Who is being limited.
 *
 * An authenticated request is keyed by the USER, which comes from a verified
 * JWT and cannot be forged. That matters twice over: it is the only half of
 * the key an attacker cannot rewrite, and it is what keeps a fleet from
 * sharing one bucket. Brazilian carriers put whole cities behind one CGNAT
 * address, and a dispatch office is one NAT — under an IP key, a hundred
 * drivers of the same carrier, or thirty dispatchers in one room, spend the
 * same 300 requests a minute and start getting refused with no abuse at all.
 *
 * Anonymous requests (login, 2FA, password recovery) have no user yet and are
 * keyed by address. Which header that address comes from is configured by
 * whoever runs the edge (TrustedProxyMode), never chosen by the caller: a
 * client-written header would hand out a new bucket per attempt.
 */
/**
 * The browser's address, as vouched for by OUR web server.
 *
 * Login, two-factor, password recovery, refresh and the public tracking pages
 * reach this API from the Next.js server, not from the browser: a server
 * action or the middleware makes the call. Every web user therefore arrived
 * from one address, whatever the proxy mode, and the per-address limits were
 * limits for the whole product — eight logins a minute for every carrier
 * together, and a refresh budget that ordinary traffic exhausted, logging
 * people out with no attacker at all.
 *
 * The web server now forwards the browser's address in a header of its own,
 * next to a secret only it and this API hold. Without the secret the header is
 * ignored — anybody can SEND the header, nobody else can make it count.
 */
const FORWARDED_CLIENT_HEADER = "x-trajetto-client-ip";
const FORWARDER_SECRET_HEADER = "x-trajetto-forwarder-secret";

/**
 * The header a Cloudflare Transform Rule on OUR zones adds (value:
 * RATE_LIMIT_EDGE_SECRET), and the two the web server relays next to the
 * browser's peer: what Cloudflare said about the browser, and that header.
 */
const EDGE_SECRET_HEADER = "x-trajetto-edge-secret";
const FORWARDED_EDGE_CLIENT_HEADER = "x-trajetto-client-edge-ip";
const FORWARDED_EDGE_SECRET_HEADER = "x-trajetto-client-edge-secret";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

type HeaderValue = string | string[] | undefined;

interface AddressEvidence {
  /** Who connected to us: the socket, or the peer our web server vouches for. */
  peer: string | undefined;
  forwardedFor?: HeaderValue;
  /** CF-Connecting-IP as it arrived. */
  edgeClient?: HeaderValue;
  edgeSecret?: HeaderValue;
}

/**
 * A Cloudflare address alone does not prove the request crossed OUR zone: a
 * Worker on anybody's account leaves from the same ranges and can write
 * CF-Connecting-IP. With RATE_LIMIT_EDGE_SECRET set, only requests carrying
 * the header our zone's Transform Rule adds are believed.
 */
function edgeSecretPresented(value: HeaderValue): boolean {
  const secret = env.RATE_LIMIT_EDGE_SECRET;
  if (!secret) return true;

  const presented = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof presented !== "string" || presented.length === 0) return false;

  return timingSafeEqual(digest(presented), digest(secret));
}

/**
 * The client's address under the configured mode — one definition for the
 * HTTP limiters and the socket handshake.
 */
function resolveClientAddress(
  evidence: AddressEvidence,
  mode: TrustedProxyMode,
): string {
  if (mode === "none") return evidence.peer ?? "unknown";

  const hop =
    lastForwardedAddress(evidence.forwardedFor) ?? evidence.peer ?? "unknown";

  if (mode !== "cloudflare") return hop;

  const client = lastForwardedAddress(evidence.edgeClient);

  if (
    client &&
    isIP(client) !== 0 &&
    isCloudflareEdge(hop) &&
    edgeSecretPresented(evidence.edgeSecret)
  ) {
    return client;
  }

  return hop;
}

/**
 * Eight groups of an IPv6 address, whatever its spelling (`::`, leading
 * zeros, an embedded IPv4 tail). Only called on what `isIP` accepted as v6.
 */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();

  const tail = text.slice(text.lastIndexOf(":") + 1);

  if (tail.includes(".")) {
    const [a, b, c, d] = tail.split(".").map(Number);
    text =
      text.slice(0, text.length - tail.length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const missing = rest === undefined ? 0 : 8 - left.length - right.length;

  return [...left, ...Array<string>(missing).fill("0"), ...right].map((group) =>
    parseInt(group, 16),
  );
}

/**
 * The bucket an address falls into.
 *
 * IPv4 keys are unchanged (`ip:a.b.c.d`), so live counters keep counting
 * across the deploy. IPv6 is keyed by its /64: a Brazilian home or mobile line
 * gets a whole /64, and keyed by the full address an attacker rotated the last
 * 64 bits for a fresh bucket per login attempt. /64 is one subscriber; a /56
 * would merge unrelated mobile users into one login bucket.
 */
function rateLimitAddressKey(address: string): string {
  const plain = address.trim().replace(/%.*$/, "");

  if (isIP(plain) !== 6) return `ip:${plain}`;

  const groups = ipv6Groups(plain);

  // ::ffff:a.b.c.d is an IPv4 client on a dual-stack socket.
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return `ip:${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }

  return `ip6:${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

function trustedForwardedClient(request: FastifyRequest): string | null {
  const secret = env.RATE_LIMIT_FORWARDER_SECRET;
  if (!secret) return null;

  const presented = request.headers[FORWARDER_SECRET_HEADER];
  if (typeof presented !== "string" || presented.length === 0) return null;

  // Compared as fixed-length digests: timingSafeEqual needs equal lengths, and
  // comparing lengths first would leak the secret's length.
  if (!timingSafeEqual(digest(presented), digest(secret))) return null;

  const address = request.headers[FORWARDED_CLIENT_HEADER];

  return typeof address === "string" && isIP(address.trim()) !== 0
    ? address.trim()
    : null;
}

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;

  const [scheme, token] = header.split(" ");

  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

/**
 * Who is calling, from the token alone — before anything reads the database.
 *
 * The limiter used to run AFTER `ensureAuthenticated` so it could key by
 * `request.user`, which meant every request it refused had already paid the
 * session lookup: four to ten statements per 429, so one valid token in a
 * loop exhausted the pool for every tenant while being "rate limited". It now
 * runs first, and the signature of the access token is enough to know whose
 * bucket this is — the same `user:` bucket as before.
 *
 * A token that does not verify is charged to the ADDRESS, like a request
 * with no token at all — never to the unverified `sub`, which would let
 * anybody drain someone else's bucket by writing their id into a token.
 *
 * It used to get a bucket of its own, by hash, so that an office behind one
 * NAT would not share a bucket whenever their tokens expired together. But a
 * bucket per token is a bucket per request for whoever invents the tokens:
 * a fresh garbage `Authorization` header on each call started at zero every
 * time, and the 8-per-minute login limit, the password-reset limits and the
 * global ceiling stopped counting anything. The office pays one 401 per tab
 * before the refresh (whose bucket is the session); that fits the address.
 */
function bearerRateLimitKey(request: FastifyRequest): string | null {
  const token = bearerOf(request);
  if (!token) return null;

  try {
    const payload = verify(token, hmacVerifyKey(auth.secret_token)) as {
      sub?: string;
      tokenType?: string;
    };

    if (payload.sub && payload.tokenType === "access") {
      return `user:${payload.sub}`;
    }
  } catch {
    // Expired, forged or garbage: counted by address, by the caller.
  }

  return null;
}

/**
 * The address an anonymous request is charged to, before bucketing.
 *
 * A call our web server relays is resolved from what IT saw (its peer, and
 * what Cloudflare said about the browser), under the same mode: behind
 * Cloudflare the web server's peer is an edge too.
 */
function clientAddress(request: FastifyRequest): string {
  const mode = (env.RATE_LIMIT_TRUSTED_PROXY ?? "none") as TrustedProxyMode;

  const vouched = trustedForwardedClient(request);

  if (vouched) {
    return resolveClientAddress(
      {
        peer: vouched,
        edgeClient: request.headers[FORWARDED_EDGE_CLIENT_HEADER],
        edgeSecret: request.headers[FORWARDED_EDGE_SECRET_HEADER],
      },
      mode,
    );
  }

  // The socket is the last resort, and the one address nobody can write.
  return resolveClientAddress(
    {
      peer: request.socket?.remoteAddress,
      forwardedFor: request.headers["x-forwarded-for"],
      edgeClient: request.headers["cf-connecting-ip"],
      edgeSecret: request.headers[EDGE_SECRET_HEADER],
    },
    mode,
  );
}

function clientRateLimitKey(request: FastifyRequest): string {
  if (request.user?.id) {
    return `user:${request.user.id}`;
  }

  const bearer = bearerRateLimitKey(request);
  if (bearer) return bearer;

  return rateLimitAddressKey(clientAddress(request));
}

/**
 * The bucket for /user/refresh-token: the SESSION, when the token proves one.
 *
 * Refreshing is the one anonymous call every signed-in person makes on a
 * schedule — every fifteen minutes, per tab and per phone — so a per-address
 * bucket was also a per-office and per-CGNAT bucket. A valid refresh token
 * names its session (the family), which cannot be forged without the refresh
 * secret; each session gets its own ten a minute, plenty for tabs racing each
 * other. Anything that does not verify is keyed by address as before, so a
 * flood of made-up tokens still hits one bucket per source.
 */
function refreshSessionRateLimitKey(request: FastifyRequest): string {
  const token = (request.body as { token?: unknown } | undefined)?.token;

  if (typeof token === "string" && token.length > 0) {
    try {
      const payload = verify(
        token,
        hmacVerifyKey(auth.secret_refresh_token),
      ) as {
        tokenType?: string;
        familyId?: string;
      };

      if (payload.tokenType === "refresh" && payload.familyId) {
        return `session:${payload.familyId}`;
      }
    } catch {
      // Expired, forged or garbage: counted by address below.
    }
  }

  return clientRateLimitKey(request);
}

/**
 * What the client gets when it crosses the limit.
 *
 * @fastify/rate-limit THROWS whatever the builder returns, and the app's error
 * handler only recognises AppError. A plain object therefore fell through to
 * the unknown-error branch: the caller was told "Internal server error" with
 * status 500, and every throttled request was logged at error level, burying
 * the real 500s. An AppError carries the status and the code the handler needs.
 */
function rateLimitExceeded(message?: string): AppError {
  return new AppError(
    message ??
      "Limite de requisições excedido. Por favor, tente novamente mais tarde.",
    429,
    "RATE_LIMITED",
  );
}

export {
  EDGE_SECRET_HEADER,
  FORWARDED_CLIENT_HEADER,
  FORWARDED_EDGE_CLIENT_HEADER,
  FORWARDED_EDGE_SECRET_HEADER,
  FORWARDER_SECRET_HEADER,
  clientAddress,
  clientRateLimitKey,
  refreshSessionRateLimitKey,
  lastForwardedAddress,
  rateLimitAddressKey,
  rateLimitExceeded,
  resolveClientAddress,
  type TrustedProxyMode,
};
