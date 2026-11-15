import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomInt, randomUUID } from "node:crypto";

/**
 * The web server talking to this API over the internal network (F1-O6).
 *
 * Today the Next.js server reaches the API through its public URL, so every
 * server-side call crosses Cloudflare and Traefik and arrives from a Traefik
 * address. The owner's switch points HTTP_REQUEST at the App Name on
 * `dokploy-network` instead: the API then sees the web container's overlay
 * address as its peer — an address outside Cloudflare's ranges, with no
 * X-Forwarded-For from Traefik in between.
 *
 * Production runs `cloudflare` mode, which believes CF-Connecting-IP only from
 * a Cloudflare peer. Without the relay below, every login, 2FA and refresh of
 * every web user would land in ONE bucket, the web container's — eight logins
 * a minute for the whole product, the bug the forwarder secret already fixed
 * once. This proves the switch keeps counting per browser:
 *
 * - with the right RATE_LIMIT_FORWARDER_SECRET, the bucket is the address the
 *   web server relays (the browser Cloudflare named, or the browser itself
 *   when no Cloudflare hop is in between);
 * - without it, the relayed headers are ignored and the bucket is the peer's,
 *   so nobody else on the network can choose a bucket by writing them.
 */
const SECRETS = vi.hoisted(() => {
  const forwarder = "f".repeat(48);
  const edge = "e".repeat(48);

  process.env.RATE_LIMIT_FORWARDER_SECRET = forwarder;
  process.env.RATE_LIMIT_EDGE_SECRET = edge;
  // What production runs behind Cloudflare.
  process.env.RATE_LIMIT_TRUSTED_PROXY = "cloudflare";

  return { forwarder, edge };
});

let app: Awaited<typeof import("@/http")>["app"];

/** Fresh addresses per run: the counters live in Redis across runs. */
const octet = () => randomInt(1, 250);
/** An overlay address of dokploy-network: not one of Cloudflare's ranges. */
const overlay = () => `10.0.${octet()}.${octet()}`;
/** 162.158.0.0/15 is a Cloudflare edge range (config/trusted-edge.ts). */
const cloudflareEdge = () => `162.158.${octet()}.${octet()}`;
const browser = () => `189.${octet()}.${octet()}.${octet()}`;

/** The login limit: eight a minute per address (routes/user-routes.ts). */
const LOGIN_LIMIT = 8;

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();
  await limiterCounting();
}, 120_000);

afterAll(async () => {
  await app?.close();
}, 60_000);

const login = (peer: string, headers: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: "/user/session",
    remoteAddress: peer,
    headers,
    payload: {
      email: `ninguem-${randomUUID()}@example.com`,
      password: "senha-errada-123",
    },
  });

/** What apiForwardingHeaders (trajetto-ui/src/lib/api-forwarding.ts) sends. */
const relayed = (
  vouched: string,
  edge?: { client: string; secret: string },
): Record<string, string> => ({
  "x-trajetto-client-ip": vouched,
  "x-trajetto-forwarder-secret": SECRETS.forwarder,
  ...(edge
    ? {
        "x-trajetto-client-edge-ip": edge.client,
        "x-trajetto-client-edge-secret": edge.secret,
      }
    : {}),
});

async function statusesOf(
  attempts: number,
  send: () => ReturnType<typeof login>,
): Promise<number[]> {
  const statuses: number[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    statuses.push((await send()).statusCode);
  }

  return statuses;
}

/**
 * Until the limiter's Redis connection is ready it fails open
 * (`skipOnError`), and a burst sent straight after boot is never counted. Waits
 * for the first response whose `remaining` moved, on a bucket of its own.
 */
async function limiterCounting(): Promise<void> {
  const address = overlay();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: address,
    });

    const remaining = Number(response.headers["x-ratelimit-remaining"]);
    const limit = Number(response.headers["x-ratelimit-limit"]);

    if (Number.isFinite(remaining) && remaining < limit) return;

    await new Promise((done) => setTimeout(done, 100));
  }

  throw new Error("o limitador nunca começou a contar");
}

describe("a web server on the internal network, with the right secret", () => {
  it("charges the browser Cloudflare named, not the web container", async () => {
    const webServer = overlay();
    const edge = cloudflareEdge();
    const attacker = browser();

    const hammering = await statusesOf(LOGIN_LIMIT + 2, () =>
      login(
        webServer,
        relayed(edge, { client: attacker, secret: SECRETS.edge }),
      ),
    );

    // The browser that hammers is throttled on its own…
    expect(hammering.slice(0, LOGIN_LIMIT)).not.toContain(429);
    expect(hammering.slice(LOGIN_LIMIT)).toEqual([429, 429]);

    // …while another browser, served by the same edge and relayed by the
    // same web container, still has its whole budget.
    const neighbour = await login(
      webServer,
      relayed(edge, { client: browser(), secret: SECRETS.edge }),
    );

    expect(neighbour.statusCode).not.toBe(429);

    // And the web container's own bucket was never touched.
    const direct = await login(webServer, {});

    expect(direct.statusCode).not.toBe(429);
  });

  it("charges the relayed address itself when no Cloudflare hop is in between", async () => {
    const webServer = overlay();
    const attacker = browser();

    const hammering = await statusesOf(LOGIN_LIMIT + 2, () =>
      login(webServer, relayed(attacker)),
    );

    expect(hammering.slice(0, LOGIN_LIMIT)).not.toContain(429);
    expect(hammering.slice(LOGIN_LIMIT)).toEqual([429, 429]);

    const neighbour = await login(webServer, relayed(browser()));

    expect(neighbour.statusCode).not.toBe(429);
  });

  it("does not believe the Cloudflare header next to a wrong edge secret", async () => {
    // The relayed peer is a Cloudflare edge, but the zone's header does not
    // match: the client header is not proof, so the bucket is the edge's —
    // the same rule a request reaching the API directly gets.
    const webServer = overlay();
    const edge = cloudflareEdge();

    const forged = await statusesOf(LOGIN_LIMIT + 2, () =>
      login(
        webServer,
        relayed(edge, { client: browser(), secret: "x".repeat(48) }),
      ),
    );

    expect(forged.slice(LOGIN_LIMIT)).toEqual([429, 429]);
  });
});

describe("a caller on the internal network without the secret", () => {
  it("is charged to its own address, whatever headers it writes", async () => {
    // Anything else on dokploy-network writing the web's headers, a new
    // "browser" and a forged CF-Connecting-IP per attempt, with a guessed
    // secret. Were the headers honoured, each attempt would open a fresh
    // bucket.
    const peer = overlay();

    const forged = await statusesOf(LOGIN_LIMIT + 2, () =>
      login(peer, {
        "x-trajetto-client-ip": browser(),
        "x-trajetto-forwarder-secret": "adivinhado".repeat(5),
        "x-trajetto-client-edge-ip": browser(),
        "cf-connecting-ip": browser(),
      }),
    );

    expect(forged.slice(0, LOGIN_LIMIT)).not.toContain(429);
    expect(forged.slice(LOGIN_LIMIT)).toEqual([429, 429]);

    // No secret at all: the same bucket, already spent.
    const bare = await login(peer, { "x-trajetto-client-ip": browser() });

    expect(bare.statusCode).toBe(429);

    // The web server on that same address, with the secret, still serves its
    // users: the peer's bucket is not theirs.
    const vouched = await login(peer, relayed(browser()));

    expect(vouched.statusCode).not.toBe(429);
  });
});
