import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The resolver, as the production container's libc behaves: it does not know
 * a bracketed IPv6 literal (Windows' getaddrinfo happens to strip the
 * brackets, which hid the bug on a developer machine), and this file never
 * reaches a real DNS server. Every name asked is recorded.
 */
const dns = vi.hoisted(() => {
  const asked: string[] = [];

  const refuse = async (host: string) => {
    asked.push(host);
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
      code: "ENOTFOUND",
    });
  };

  class Resolver {
    resolve4 = refuse;
    resolve6 = refuse;
    setServers() {}
    cancel() {}
  }

  return { asked, lookup: refuse, Resolver };
});

vi.mock("node:dns/promises", () => ({
  default: { lookup: dns.lookup, Resolver: dns.Resolver },
  lookup: dns.lookup,
  Resolver: dns.Resolver,
}));

import { saveWebhookEndpointSchema } from "@/schemas/integration-schema";

import {
  safeWebhookHeaders,
  verifyWebhookDestination,
} from "@/shared/integration/webhook-destination";

/**
 * What an endpoint may be registered with.
 *
 * Every refusal below used to be accepted at registration and fail at send
 * time instead: a header value with a line break, a hop-by-hop header, a URL
 * with credentials in it. Each of those makes every single POST throw, the
 * failure is counted as transient, and twenty events later the endpoint is
 * switched off — with nothing on the registration screen that said why.
 */
const valid = {
  name: "ERP",
  url: "https://erp.exemplo.com.br/webhooks",
  topics: ["delivery.created"],
};

function accepts(input: Record<string, unknown>): boolean {
  return saveWebhookEndpointSchema.safeParse({ ...valid, ...input }).success;
}

describe("the headers a customer registers", () => {
  it("accepts what a gateway ordinarily asks for", () => {
    expect(
      accepts({
        headers: { Authorization: "Bearer abc.def", "X-Api-Key": "k-123" },
      }),
    ).toBe(true);
  });

  it("refuses a value with a line break, which no request can carry", () => {
    expect(accepts({ headers: { "X-A": "a\r\nB: 1" } })).toBe(false);
    expect(accepts({ headers: { "X-A": "a\nb" } })).toBe(false);
    expect(accepts({ headers: { "X-A": "a\u0000b" } })).toBe(false);
  });

  it("refuses a name that is not an HTTP token", () => {
    expect(accepts({ headers: { "Bad Name": "1" } })).toBe(false);
    expect(accepts({ headers: { "X-A:": "1" } })).toBe(false);
    expect(accepts({ headers: { "": "1" } })).toBe(false);
  });

  it("refuses a value past a kilobyte", () => {
    expect(accepts({ headers: { "X-A": "a".repeat(1025) } })).toBe(false);
  });

  it("refuses the hop-by-hop headers the HTTP client will not send", () => {
    for (const name of [
      "Keep-Alive",
      "Expect",
      "TE",
      "Trailer",
      "Proxy-Authorization",
      "Proxy-Anything",
      "Accept-Encoding",
      "X-Trajetto-Whatever",
    ]) {
      expect(accepts({ headers: { [name]: "1" } }), name).toBe(false);
    }
  });

  it("lets an API caller clear them with null", () => {
    expect(accepts({ headers: null })).toBe(true);
  });
});

describe("the URL a customer registers", () => {
  it("refuses credentials in the URL, which the HTTP client refuses to send", () => {
    expect(accepts({ url: "https://u:p@erp.exemplo.com.br/hook" })).toBe(false);
    expect(accepts({ url: "https://u@erp.exemplo.com.br/hook" })).toBe(false);
  });

  it("accepts an IPv6 literal", () => {
    expect(accepts({ url: "https://[2606:4700::1111]/hook" })).toBe(true);
  });
});

describe("a row saved before these rules", () => {
  it("is sent without the headers it could never have carried", () => {
    expect(
      safeWebhookHeaders({
        "X-A": "a\r\nB: 1",
        "Keep-Alive": "timeout=5",
        "Bad Name": "1",
        Authorization: "Bearer deles",
      }),
    ).toEqual({ Authorization: "Bearer deles" });
  });

  it("is refused for good when its URL carries credentials", async () => {
    const verdict = await verifyWebhookDestination(
      "https://u:p@erp.exemplo.com.br/hook",
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.transient).toBeFalsy();
  });
});

describe("an IPv6 literal on the way out", () => {
  beforeEach(() => {
    dns.asked.length = 0;
  });

  it("is judged as the address it is, without asking the DNS", async () => {
    // The hostname comes with its brackets, `isIP` said no, and the literal
    // went to the resolver — which cannot resolve it, so every event was a
    // "transient" failure until the breaker switched the endpoint off.
    await expect(
      verifyWebhookDestination("https://[2606:4700::1111]/hook"),
    ).resolves.toEqual({ allowed: true });

    expect(dns.asked).toEqual([]);
  });

  it("and a private one is refused for good", async () => {
    for (const url of ["https://[::1]/", "https://[fd00::5]:8443/", "https://[::ffff:10.0.0.5]/"]) {
      const verdict = await verifyWebhookDestination(url);

      expect(verdict.allowed, url).toBe(false);
      expect(verdict.transient, url).toBeFalsy();
    }
  });
});
