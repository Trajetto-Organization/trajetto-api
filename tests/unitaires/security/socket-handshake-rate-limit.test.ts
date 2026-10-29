import { describe, expect, it } from "vitest";

import {
  HANDSHAKES_PER_ADDRESS,
  HANDSHAKES_PER_USER,
  HANDSHAKE_WINDOW_SECONDS,
  addressHandshakeKey,
  createHandshakeLimiter,
  handshakeAddress,
  unlimitedHandshakes,
  userHandshakeKey,
} from "@/shared/socket/handshake-rate-limit";

/**
 * The handshake limiter, and the header it is allowed to believe.
 *
 * Socket.IO answers `/socket.io/` before Fastify sees it, so no HTTP limiter
 * ever applied to a connection attempt. Adding one is easy; adding one that
 * cannot be walked around is the part worth testing, and this project already
 * shipped that bug once on the HTTP side — the limiter keyed off a header the
 * client writes, so an attacker got a fresh bucket per request and the 8/min
 * on login held nothing.
 */
describe("which address a handshake is charged to", () => {
  const headers = {
    "x-forwarded-for": "1.2.3.4, 9.9.9.9",
    "cf-connecting-ip": "5.5.5.5",
  };

  it("uses the socket address when no proxy is trusted", () => {
    expect(handshakeAddress({ address: "10.0.0.1", headers }, "none")).toBe(
      "10.0.0.1",
    );
  });

  it("reads the LAST forwarded entry, never the first", () => {
    // The first entry is whatever the client wrote; a trusted proxy appends
    // the peer it actually saw. Reading the first hands out a bucket per
    // forged value.
    expect(handshakeAddress({ address: "10.0.0.1", headers }, "xff")).toBe(
      "9.9.9.9",
    );
  });

  it("uses the Cloudflare header only in Cloudflare mode, from a Cloudflare peer", () => {
    // 172.70.1.1 is a Cloudflare edge (172.64.0.0/13). With the non-Cloudflare
    // peer of `headers` (9.9.9.9) the header is somebody's own writing.
    expect(
      handshakeAddress(
        {
          address: "10.0.0.1",
          headers: {
            "x-forwarded-for": "172.70.1.1",
            "cf-connecting-ip": "5.5.5.5",
          },
        },
        "cloudflare",
      ),
    ).toBe("5.5.5.5");

    expect(
      handshakeAddress({ address: "10.0.0.1", headers }, "cloudflare"),
    ).toBe("9.9.9.9");
  });

  it("falls back to the socket address when the header is absent", () => {
    expect(handshakeAddress({ address: "10.0.0.1", headers: {} }, "xff")).toBe(
      "10.0.0.1",
    );
  });

  it("never returns an empty key", () => {
    expect(handshakeAddress({ headers: {} }, "xff")).toBe("unknown");
  });

  it("keeps the two kinds of key apart", () => {
    // A user id and an address must never collide into one bucket.
    expect(addressHandshakeKey("1.2.3.4")).not.toBe(
      userHandshakeKey("1.2.3.4"),
    );
  });

  /**
   * One bucket per subject — the property, not the spelling.
   *
   * A mutation that collapsed `userHandshakeKey` to a constant survived both
   * suites: the E2E built its key with the same function it was testing, so
   * the two agreed all the way down, and the unit file only compared the two
   * KINDS of key. What that mutation actually did was put every account on the
   * platform into one bucket — thirty handshakes a minute for everybody, which
   * is an outage, not a limit.
   */
  it("gives every user their own bucket", () => {
    expect(userHandshakeKey("user-a")).not.toBe(userHandshakeKey("user-b"));
    expect(userHandshakeKey("user-a")).toContain("user-a");
  });

  it("gives every address its own bucket", () => {
    expect(addressHandshakeKey("1.1.1.1")).not.toBe(
      addressHandshakeKey("2.2.2.2"),
    );
    expect(addressHandshakeKey("1.1.1.1")).toContain("1.1.1.1");
  });
});

/**
 * A Redis stand-in that records what was asked of it.
 *
 * The limiter sends one script (INCR, then EXPIRE when the key has no TTL);
 * this double applies those semantics. The script itself runs against a real
 * Redis in tests/E2E/socket-handshake-window.test.ts.
 */
function redisDouble() {
  const counters = new Map<string, number>();
  const armed = new Set<string>();
  const expiries: Array<{ key: string; seconds: number }> = [];

  return {
    counters,
    expiries,
    client: {
      eval: async (
        _script: string,
        _numberOfKeys: number,
        key: string,
        seconds: number,
      ) => {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);

        if (!armed.has(key)) {
          armed.add(key);
          expiries.push({ key, seconds });
        }

        return next;
      },
    },
  };
}

describe("the counter", () => {
  it("allows up to the limit and refuses past it", async () => {
    const { client } = redisDouble();
    const limiter = createHandshakeLimiter(client as never);

    const verdicts: boolean[] = [];

    for (let attempt = 0; attempt < 5; attempt++) {
      verdicts.push(await limiter.allow("k", 3));
    }

    expect(verdicts).toEqual([true, true, true, false, false]);
  });

  it("sets the window once, on the attempt that creates the bucket", async () => {
    const { client, expiries } = redisDouble();
    const limiter = createHandshakeLimiter(client as never);

    await limiter.allow("k", 10);
    await limiter.allow("k", 10);
    await limiter.allow("k", 10);

    // Expiring on every attempt would push the window forward forever, and a
    // steady stream of connections would never reset the count.
    expect(expiries).toEqual([{ key: "k", seconds: HANDSHAKE_WINDOW_SECONDS }]);
  });

  it("counts each key on its own", async () => {
    const { client } = redisDouble();
    const limiter = createHandshakeLimiter(client as never);

    await limiter.allow("a", 1);

    expect(await limiter.allow("b", 1)).toBe(true);
    expect(await limiter.allow("a", 1)).toBe(false);
  });

  it("fails open when Redis is unreachable", async () => {
    const limiter = createHandshakeLimiter({
      eval: async () => {
        throw new Error("sem redis");
      },
    } as never);

    // The limiter bounds abuse; it is not a second dependency the product
    // cannot run without. A Redis outage must not cut everyone off realtime.
    expect(await limiter.allow("k", 1)).toBe(true);
  });
});

describe("the budgets", () => {
  it("gives an address far more room than a single account", () => {
    // A dispatch office is one NAT: thirty people and their tabs reconnect
    // together after a network blip, and they must not refuse each other.
    expect(HANDSHAKES_PER_ADDRESS).toBeGreaterThan(HANDSHAKES_PER_USER * 5);
  });

  it("still bounds one account to something a client never reaches", () => {
    // A well-behaved client connects once and stays connected; this is only
    // ever hit by a loop.
    expect(HANDSHAKES_PER_USER).toBeLessThanOrEqual(60);
  });
});

describe("the fallback limiter", () => {
  it("refuses nothing", async () => {
    expect(await unlimitedHandshakes.allow("k", 0)).toBe(true);
  });
});
