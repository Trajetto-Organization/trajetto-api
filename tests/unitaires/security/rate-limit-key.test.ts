import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientRateLimitKey,
  lastForwardedAddress,
} from "@/config/rate-limit";

vi.mock("@/env", () => ({
  env: { get RATE_LIMIT_TRUSTED_PROXY() { return mode; } },
}));

let mode = "none";

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
) {
  return {
    headers,
    socket: { remoteAddress },
    user,
  } as never;
}

afterEach(() => {
  mode = "none";
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
  it("reads the header Cloudflare overwrites", () => {
    mode = "cloudflare";

    expect(
      clientRateLimitKey(requestWith({ "cf-connecting-ip": "200.160.2.3" })),
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
