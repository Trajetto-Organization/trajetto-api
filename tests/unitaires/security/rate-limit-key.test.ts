import { afterEach, describe, expect, it, vi } from "vitest";

import { sign } from "jsonwebtoken";

import {
  FORWARDED_CLIENT_HEADER,
  FORWARDER_SECRET_HEADER,
  clientRateLimitKey,
  lastForwardedAddress,
  refreshSessionRateLimitKey,
} from "@/config/rate-limit";

const REFRESH_SECRET = "refresh-secret-for-this-test-only";
const FORWARDER_SECRET = "f".repeat(40);

vi.mock("@/env", () => ({
  env: {
    get RATE_LIMIT_TRUSTED_PROXY() { return mode; },
    get RATE_LIMIT_FORWARDER_SECRET() { return forwarderSecret; },
    JWT_SECRET: "access-secret-for-this-test-only",
    JWT_SECRET_REFRESH_TOKEN: "refresh-secret-for-this-test-only",
  },
}));

let mode = "none";
let forwarderSecret: string | undefined;

/**
 * Which bucket an anonymous request falls into.
 *
 * It is the only thing between an attacker and brute force on login and on
 * two-factor, and it was on the wrong side: the code read `cf-connecting-ip`
 * FIRST — the one header production's Traefik does not rewrite. Sending
 * `Cf-Connecting-Ip: 1.2.3.<n>` handed out a fresh bucket per request, and the
 * 8/min on login and 4/min on two-factor held nothing at all.
 */
function requestWith(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress = "10.9.9.9",
  user?: { id: string },
  body?: unknown,
) {
  return {
    headers,
    socket: { remoteAddress },
    user,
    body,
  } as never;
}

afterEach(() => {
  mode = "none";
  forwarderSecret = undefined;
});

describe("an authenticated request", () => {
  it("is limited by the user, which comes from a verified JWT", () => {
    // The one half of the key an attacker cannot rewrite — and what keeps a
    // whole fleet behind one NAT from sharing a single bucket.
    expect(
      clientRateLimitKey(
        requestWith({ "cf-connecting-ip": "1.2.3.4" }, "10.0.0.1", {
          id: "user-1",
        }),
      ),
    ).toBe("user:user-1");
  });
});

describe("an anonymous request, with no proxy configured", () => {
  it("uses the socket and ignores every header", () => {
    const key = clientRateLimitKey(
      requestWith({
        "cf-connecting-ip": "1.2.3.4",
        "x-forwarded-for": "5.6.7.8",
        "x-real-ip": "9.9.9.9",
      }),
    );

    // The socket is the only address the sender does not get to write.
    expect(key).toBe("ip:10.9.9.9");
  });

  it("does not let an attacker pick their own bucket", () => {
    const first = clientRateLimitKey(
      requestWith({ "cf-connecting-ip": "1.2.3.1" }),
    );

    const second = clientRateLimitKey(
      requestWith({ "cf-connecting-ip": "1.2.3.2" }),
    );

    // The whole attack in two lines: if these keys differed, every password
    // attempt would carry its own limit.
    expect(first).toBe(second);
  });
});

describe("behind Traefik or nginx", () => {
  it("reads the LAST entry of X-Forwarded-For", () => {
    mode = "xff";

    // The first value is whatever the client wrote; the trusted proxy
    // appends the real peer at the end.
    expect(
      clientRateLimitKey(
        requestWith({ "x-forwarded-for": "1.2.3.4, 200.160.2.3" }),
      ),
    ).toBe("ip:200.160.2.3");
  });

  it("still ignores the Cloudflare header", () => {
    mode = "xff";

    // This was the hole: Traefik does not rewrite `cf-connecting-ip`, so
    // reading it is reading whatever the client sent.
    expect(
      clientRateLimitKey(
        requestWith({
          "cf-connecting-ip": "1.2.3.4",
          "x-forwarded-for": "200.160.2.3",
        }),
      ),
    ).toBe("ip:200.160.2.3");
  });

  it("falls back to the socket when the header is absent", () => {
    mode = "xff";

    expect(clientRateLimitKey(requestWith({}))).toBe("ip:10.9.9.9");
  });
});

describe("behind Cloudflare", () => {
  it("reads the header Cloudflare overwrites, when the peer is Cloudflare", () => {
    mode = "cloudflare";

    // 172.70.1.1 is a Cloudflare edge (172.64.0.0/13), appended by Traefik.
    // The spoofing cases live in rate-limit-edge.test.ts.
    expect(
      clientRateLimitKey(
        requestWith({
          "x-forwarded-for": "172.70.1.1",
          "cf-connecting-ip": "200.160.2.3",
        }),
      ),
    ).toBe("ip:200.160.2.3");
  });
});

describe("reading a forwarding chain", () => {
  it("returns the last hop", () => {
    expect(lastForwardedAddress("1.1.1.1, 2.2.2.2, 3.3.3.3")).toBe("3.3.3.3");
  });

  it("copes with spaces and empty entries", () => {
    expect(lastForwardedAddress("  1.1.1.1 ,  , 2.2.2.2  ")).toBe("2.2.2.2");
  });

  it("copes with a repeated header, which arrives as a list", () => {
    expect(lastForwardedAddress(["1.1.1.1", "2.2.2.2, 3.3.3.3"])).toBe(
      "3.3.3.3",
    );
  });

  it("answers nothing when there is nothing", () => {
    expect(lastForwardedAddress(undefined)).toBeNull();
    expect(lastForwardedAddress("")).toBeNull();
    expect(lastForwardedAddress("  ,  ")).toBeNull();
  });
});

/**
 * Calls the web server makes on a browser's behalf.
 *
 * Login, 2FA, password recovery, refresh and tracking come from the Next.js
 * server. Before, every web user therefore shared the web server's address —
 * one bucket of eight logins a minute for the whole product.
 */
describe("a call relayed by the web server", () => {
  const relayed = (secret: string | undefined, client = "189.40.1.7") =>
    requestWith(
      {
        [FORWARDED_CLIENT_HEADER]: client,
        ...(secret !== undefined ? { [FORWARDER_SECRET_HEADER]: secret } : {}),
      },
      "10.0.0.50", // the web server's own address
    );

  it("is counted by the browser's address when the secret matches", () => {
    forwarderSecret = FORWARDER_SECRET;

    expect(clientRateLimitKey(relayed(FORWARDER_SECRET))).toBe(
      "ip:189.40.1.7",
    );
  });

  it("keeps two browsers behind the same web server apart", () => {
    forwarderSecret = FORWARDER_SECRET;

    expect(clientRateLimitKey(relayed(FORWARDER_SECRET, "189.40.1.7"))).not.toBe(
      clientRateLimitKey(relayed(FORWARDER_SECRET, "177.12.9.3")),
    );
  });

  it("ignores the header without the secret — anybody can send it", () => {
    forwarderSecret = FORWARDER_SECRET;

    expect(clientRateLimitKey(relayed(undefined))).toBe("ip:10.0.0.50");
    expect(clientRateLimitKey(relayed("wrong".repeat(10)))).toBe(
      "ip:10.0.0.50",
    );
  });

  it("ignores the header when this API holds no secret at all", () => {
    forwarderSecret = undefined;

    expect(clientRateLimitKey(relayed(FORWARDER_SECRET))).toBe(
      "ip:10.0.0.50",
    );
  });

  it("ignores a forwarded value that is not an address", () => {
    forwarderSecret = FORWARDER_SECRET;

    expect(
      clientRateLimitKey(relayed(FORWARDER_SECRET, "not-an-ip; drop table")),
    ).toBe("ip:10.0.0.50");
  });
});

describe("the refresh bucket", () => {
  const refreshToken = (familyId: string, secret = REFRESH_SECRET) =>
    sign({ tokenType: "refresh", familyId, sessionVersion: 0 }, secret, {
      subject: "user-1",
      expiresIn: "1d",
    });

  it("is the session a verified refresh token names", () => {
    expect(
      refreshSessionRateLimitKey(
        requestWith({}, "10.0.0.50", undefined, {
          token: refreshToken("family-1"),
        }),
      ),
    ).toBe("session:family-1");
  });

  it("gives each session its own budget behind the same address", () => {
    const first = refreshSessionRateLimitKey(
      requestWith({}, "10.0.0.50", undefined, { token: refreshToken("a") }),
    );
    const second = refreshSessionRateLimitKey(
      requestWith({}, "10.0.0.50", undefined, { token: refreshToken("b") }),
    );

    expect(first).not.toBe(second);
  });

  it("counts a forged token by address — a made-up family buys nothing", () => {
    expect(
      refreshSessionRateLimitKey(
        requestWith({}, "10.0.0.50", undefined, {
          token: refreshToken("family-1", "not-our-secret"),
        }),
      ),
    ).toBe("ip:10.0.0.50");

    expect(
      refreshSessionRateLimitKey(
        requestWith({}, "10.0.0.50", undefined, { token: "garbage" }),
      ),
    ).toBe("ip:10.0.0.50");
  });
});
