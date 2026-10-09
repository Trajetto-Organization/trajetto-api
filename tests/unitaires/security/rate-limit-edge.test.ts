import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FORWARDED_CLIENT_HEADER,
  FORWARDER_SECRET_HEADER,
  clientRateLimitKey,
} from "@/config/rate-limit";
import {
  addressHandshakeKey,
  handshakeAddress,
} from "@/shared/socket/handshake-rate-limit";

vi.mock("@/env", () => ({
  env: {
    get RATE_LIMIT_TRUSTED_PROXY() { return mode; },
    get RATE_LIMIT_FORWARDER_SECRET() { return forwarderSecret; },
    get RATE_LIMIT_EDGE_SECRET() { return edgeSecret; },
    JWT_SECRET: "access-secret-for-this-test-only",
    JWT_SECRET_REFRESH_TOKEN: "refresh-secret-for-this-test-only",
  },
}));

let mode = "none";
let forwarderSecret: string | undefined;
let edgeSecret: string | undefined;

const FORWARDER_SECRET = "f".repeat(40);
const EDGE_SECRET = "e".repeat(40);

// Inside Cloudflare's published ranges (172.64.0.0/13, 162.158.0.0/15).
const CF_EDGE = "172.70.1.1";
const CF_EDGE_2 = "162.158.9.9";

// What Traefik itself connects from: an address on the overlay.
const TRAEFIK = "10.0.1.5";

afterEach(() => {
  mode = "none";
  forwarderSecret = undefined;
  edgeSecret = undefined;
});

function request(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress = TRAEFIK,
) {
  return { headers, socket: { remoteAddress } } as never;
}

/**
 * Production is Cloudflare -> Traefik -> API.
 *
 * Traefik appends the peer it saw to X-Forwarded-For, so behind Cloudflare the
 * LAST entry is a Cloudflare edge address shared by thousands of users: `xff`
 * put all of them into one login bucket. `cloudflare` read CF-Connecting-IP
 * blindly, and anybody who reached the origin directly (it answers on its own
 * IP) wrote that header and picked a fresh bucket per password attempt.
 *
 * The header is believed now only when the peer Traefik saw really is
 * Cloudflare — the one thing a direct caller cannot fake.
 */
describe("behind Cloudflare", () => {
  it("counts the client Cloudflare names when the peer is a Cloudflare edge", () => {
    mode = "cloudflare";

    expect(
      clientRateLimitKey(
        request({
          "x-forwarded-for": `9.9.9.9, ${CF_EDGE}`,
          "cf-connecting-ip": "203.0.113.7",
        }),
      ),
    ).toBe("ip:203.0.113.7");
  });

  it("ignores a forged header from a caller that went straight to the origin", () => {
    mode = "cloudflare";

    // Traefik appended the attacker's own address; the header is theirs too.
    expect(
      clientRateLimitKey(
        request({
          "x-forwarded-for": "198.51.100.9",
          "cf-connecting-ip": "1.2.3.4",
        }),
      ),
    ).toBe("ip:198.51.100.9");
  });

  it("gives an attacker at the origin ONE bucket, whatever the header says", () => {
    mode = "cloudflare";

    const attempts = new Set(
      [1, 2, 3, 4, 5].map((n) =>
        clientRateLimitKey(
          request({
            "x-forwarded-for": "198.51.100.9",
            "cf-connecting-ip": `1.2.3.${n}`,
          }),
        ),
      ),
    );

    expect(attempts.size).toBe(1);
  });

  it("does not trust an overlay address as the edge (Swarm ingress SNAT)", () => {
    mode = "cloudflare";

    expect(
      clientRateLimitKey(
        request({ "x-forwarded-for": "10.0.0.5", "cf-connecting-ip": "1.2.3.4" }),
      ),
    ).toBe("ip:10.0.0.5");
  });

  it("falls back to the peer when the header is not an address", () => {
    mode = "cloudflare";

    expect(
      clientRateLimitKey(
        request({
          "x-forwarded-for": CF_EDGE,
          "cf-connecting-ip": "not-an-ip; drop table",
        }),
      ),
    ).toBe(`ip:${CF_EDGE}`);
  });

  it("uses the socket as the peer when no proxy appended one", () => {
    mode = "cloudflare";

    expect(
      clientRateLimitKey(
        request({ "cf-connecting-ip": "203.0.113.7" }, CF_EDGE_2),
      ),
    ).toBe("ip:203.0.113.7");

    expect(
      clientRateLimitKey(request({ "cf-connecting-ip": "203.0.113.7" }, TRAEFIK)),
    ).toBe(`ip:${TRAEFIK}`);
  });

  it("still ignores the Cloudflare header in `xff` mode", () => {
    mode = "xff";

    expect(
      clientRateLimitKey(
        request({ "x-forwarded-for": CF_EDGE, "cf-connecting-ip": "203.0.113.7" }),
      ),
    ).toBe(`ip:${CF_EDGE}`);
  });
});

/**
 * A request relayed from a Cloudflare IP is not proof it came through OUR
 * zone: a Worker on anybody's account leaves from those ranges. With
 * RATE_LIMIT_EDGE_SECRET set, a Transform Rule on our zones adds a header only
 * our edge knows, and the client header counts only next to it.
 */
describe("with an edge secret configured", () => {
  const viaEdge = (secret?: string) =>
    request({
      "x-forwarded-for": CF_EDGE,
      "cf-connecting-ip": "203.0.113.7",
      ...(secret !== undefined ? { "x-trajetto-edge-secret": secret } : {}),
    });

  it("believes the client header next to the secret", () => {
    mode = "cloudflare";
    edgeSecret = EDGE_SECRET;

    expect(clientRateLimitKey(viaEdge(EDGE_SECRET))).toBe("ip:203.0.113.7");
  });

  it("counts the peer without it, or with a wrong one", () => {
    mode = "cloudflare";
    edgeSecret = EDGE_SECRET;

    expect(clientRateLimitKey(viaEdge())).toBe(`ip:${CF_EDGE}`);
    expect(clientRateLimitKey(viaEdge("x".repeat(40)))).toBe(`ip:${CF_EDGE}`);
  });
});

/**
 * Login, 2FA and recovery reach the API from the Next.js server. It relays
 * what ITS Traefik saw — behind Cloudflare, an edge address — so the same
 * verification has to happen on the relayed values, or every web user lands
 * in the bucket of whichever Cloudflare edge served them.
 */
describe("a call relayed by the web server behind Cloudflare", () => {
  const relayed = (peer: string, edgeClient?: string, extra = {}) =>
    request(
      {
        [FORWARDER_SECRET_HEADER]: FORWARDER_SECRET,
        [FORWARDED_CLIENT_HEADER]: peer,
        ...(edgeClient ? { "x-trajetto-client-edge-ip": edgeClient } : {}),
        ...extra,
      },
      "10.0.0.50",
    );

  it("counts the browser Cloudflare named to the web server", () => {
    mode = "cloudflare";
    forwarderSecret = FORWARDER_SECRET;

    expect(clientRateLimitKey(relayed(CF_EDGE, "203.0.113.7"))).toBe(
      "ip:203.0.113.7",
    );
  });

  it("keeps two browsers behind the same edge apart", () => {
    mode = "cloudflare";
    forwarderSecret = FORWARDER_SECRET;

    expect(clientRateLimitKey(relayed(CF_EDGE, "203.0.113.7"))).not.toBe(
      clientRateLimitKey(relayed(CF_EDGE, "203.0.113.8")),
    );
  });

  it("ignores the relayed header when the web server's peer was not Cloudflare", () => {
    mode = "cloudflare";
    forwarderSecret = FORWARDER_SECRET;

    expect(clientRateLimitKey(relayed("189.40.1.7", "1.2.3.4"))).toBe(
      "ip:189.40.1.7",
    );
  });

  it("applies the edge secret to the relayed values too", () => {
    mode = "cloudflare";
    forwarderSecret = FORWARDER_SECRET;
    edgeSecret = EDGE_SECRET;

    expect(clientRateLimitKey(relayed(CF_EDGE, "203.0.113.7"))).toBe(
      `ip:${CF_EDGE}`,
    );
    expect(
      clientRateLimitKey(
        relayed(CF_EDGE, "203.0.113.7", {
          "x-trajetto-client-edge-secret": EDGE_SECRET,
        }),
      ),
    ).toBe("ip:203.0.113.7");
  });

  it("means nothing without the forwarder secret", () => {
    mode = "cloudflare";
    forwarderSecret = undefined;

    expect(clientRateLimitKey(relayed(CF_EDGE, "203.0.113.7"))).toBe(
      "ip:10.0.0.50",
    );
  });
});

/**
 * One subscriber, one bucket — even on IPv6.
 *
 * A home or mobile line in Brazil gets a whole /64. Keyed by the full address,
 * an attacker rotates the last 64 bits and gets a fresh bucket per attempt:
 * the 8/min on login held nothing. Behind Cloudflare, CF-Connecting-IP carries
 * that full IPv6 address.
 */
describe("IPv6 clients", () => {
  const behindCloudflare = (client: string) =>
    request({ "x-forwarded-for": CF_EDGE, "cf-connecting-ip": client });

  it("share one bucket per /64", () => {
    mode = "cloudflare";

    const first = clientRateLimitKey(behindCloudflare("2001:db8:abcd:12::1"));
    const second = clientRateLimitKey(
      behindCloudflare("2001:db8:abcd:12:ffff::2"),
    );

    expect(first).toBe(second);
    expect(first).toBe("ip6:2001:db8:abcd:12::/64");
  });

  it("does not merge neighbouring /64s", () => {
    mode = "cloudflare";

    expect(clientRateLimitKey(behindCloudflare("2001:db8:abcd:13::1"))).not.toBe(
      clientRateLimitKey(behindCloudflare("2001:db8:abcd:12::1")),
    );
  });

  it("reads every spelling of the same address the same way", () => {
    mode = "xff";

    expect(
      clientRateLimitKey(
        request({
          "x-forwarded-for": "2001:0DB8:ABCD:0012:0000:0000:0000:0001",
        }),
      ),
    ).toBe("ip6:2001:db8:abcd:12::/64");
  });

  it("aggregates in `xff` mode and on relayed calls too", () => {
    mode = "xff";
    forwarderSecret = FORWARDER_SECRET;

    expect(
      clientRateLimitKey(request({ "x-forwarded-for": "2001:db8:1:2:3::9" })),
    ).toBe("ip6:2001:db8:1:2::/64");

    expect(
      clientRateLimitKey(
        request(
          {
            [FORWARDER_SECRET_HEADER]: FORWARDER_SECRET,
            [FORWARDED_CLIENT_HEADER]: "2001:db8:1:2:4::9",
          },
          "10.0.0.50",
        ),
      ),
    ).toBe("ip6:2001:db8:1:2::/64");
  });

  it("keeps IPv4 keys exactly as they were", () => {
    mode = "xff";

    expect(
      clientRateLimitKey(request({ "x-forwarded-for": "203.0.113.7" })),
    ).toBe("ip:203.0.113.7");
  });

  it("reads an IPv4-mapped socket address as the IPv4 it is", () => {
    expect(clientRateLimitKey(request({}, "::ffff:1.2.3.4"))).toBe("ip:1.2.3.4");
  });

  it("copes with a zone id", () => {
    expect(clientRateLimitKey(request({}, "fe80::1%eth0"))).toBe(
      "ip6:fe80:0:0:0::/64",
    );
  });
});

describe("the socket handshake", () => {
  it("applies the same edge verification", () => {
    expect(
      handshakeAddress(
        {
          address: TRAEFIK,
          headers: { "x-forwarded-for": CF_EDGE, "cf-connecting-ip": "203.0.113.7" },
        },
        "cloudflare",
      ),
    ).toBe("203.0.113.7");

    expect(
      handshakeAddress(
        {
          address: TRAEFIK,
          headers: { "x-forwarded-for": "198.51.100.9", "cf-connecting-ip": "1.2.3.4" },
        },
        "cloudflare",
      ),
    ).toBe("198.51.100.9");
  });

  it("counts one /64 as one address", () => {
    expect(addressHandshakeKey("2001:db8:abcd:12::1")).toBe(
      addressHandshakeKey("2001:db8:abcd:12:ffff::2"),
    );
    expect(addressHandshakeKey("2001:db8:abcd:13::1")).not.toBe(
      addressHandshakeKey("2001:db8:abcd:12::1"),
    );
  });

  it("keeps the IPv4 key byte-identical, so no live counter resets", () => {
    expect(addressHandshakeKey("1.2.3.4")).toBe("socket-handshake:ip:1.2.3.4");
  });
});
