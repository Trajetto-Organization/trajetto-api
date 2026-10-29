import { describe, expect, it } from "vitest";

import {
  RESERVED_WEBHOOK_HEADERS,
  hasBlockedName,
  isPrivateAddress,
  reservedHeaderNames,
  safeWebhookHeaders,
  verifyWebhookDestination,
} from "@/shared/integration/webhook-destination";

/**
 * "Ask your server to fetch this address."
 *
 * That is what a webhook is, seen from outside, and it is why the destination
 * needs a brake. Without one, the administrator of ANY carrier points an
 * endpoint at `169.254.169.254` and reads the instance credentials through the
 * monitor itself — which hands them the response body, with the status and the
 * latency thrown in, and that alone is a scanner for internal ports.
 */
describe("addresses that are never a customer", () => {
  it("refuses loopback, private and link-local", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("refuses the ranges nobody remembers", () => {
    // Carrier-grade NAT and the benchmarking range. A list that covers only
    // 10/172/192 lets both of them through.
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("198.18.0.1")).toBe(true);

    expect(isPrivateAddress("224.0.0.1")).toBe(true);
  });

  it("refuses the IPv6 equivalents", () => {
    for (const address of ["::1", "::", "fe80::1", "fd00::1", "fc00::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("refuses an IPv4 dressed as IPv6", () => {
    // `::ffff:10.0.0.5` is 10.0.0.5 wearing another coat, and a check that
    // looked only at the prefix would let it through.
    expect(isPrivateAddress("::ffff:10.0.0.5")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("accepts a genuinely public address", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("200.160.2.3")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("refuses what is not an address at all", () => {
    // When in doubt, nothing leaves. The opposite — letting through whatever
    // could not be parsed — is the most common way a blocklist gets walked
    // around.
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("names that are never a customer", () => {
  it("refuses localhost and the internal domains", () => {
    for (const host of [
      "localhost",
      "api.localhost",
      "service.internal",
      "something.cluster.local",
      "printer.local",
      "metadata.google.internal",
    ]) {
      expect(hasBlockedName(host), host).toBe(true);
    }
  });

  it("does not refuse a customer domain that merely looks similar", () => {
    // `localhost.exemplo.com.br` is a legitimate public domain.
    expect(hasBlockedName("localhost.exemplo.com.br")).toBe(false);
    expect(hasBlockedName("erp.exemplo.com.br")).toBe(false);
  });
});

describe("deciding a send", () => {
  it("refuses http, even for a row that was already saved", () => {
    // The rule has been in the schema all along, but a row saved before it
    // would stay valid forever without this second lock.
    return expect(
      verifyWebhookDestination("http://erp.exemplo.com.br/hook"),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("refuses a private literal without resolving anything", async () => {
    const verdict = await verifyWebhookDestination("https://169.254.169.254/");

    expect(verdict.allowed).toBe(false);
  });

  it("refuses an internal name", async () => {
    expect(
      (await verifyWebhookDestination("https://localhost:9200/_cat")).allowed,
    ).toBe(false);
  });

  it("refuses a URL that is not a URL", async () => {
    expect((await verifyWebhookDestination("not a url")).allowed).toBe(false);
  });

  it("never says which address it found", async () => {
    // The monitor is visible to the customer themselves. Answering "10.0.0.5
    // is private" would turn the error message into the very port-scanning
    // oracle this check exists to prevent.
    const verdict = await verifyWebhookDestination("https://127.0.0.1/hook");

    expect(verdict.reason).toBeTruthy();
    expect(verdict.reason).not.toContain("127");
    expect(verdict.reason).not.toContain("privado");
  });
});

describe("headers the customer does not write", () => {
  it("recognises the reserved ones, in any case", () => {
    expect(
      reservedHeaderNames({
        "X-Trajetto-Signature": "forged",
        "x-trajetto-topic": "another",
        HOST: "internal.svc",
        "X-Api-Key": "theirs",
      }).sort(),
    ).toEqual(["HOST", "X-Trajetto-Signature", "x-trajetto-topic"]);
  });

  it("lets the customer own headers through", () => {
    expect(reservedHeaderNames({ Authorization: "Bearer theirs" })).toEqual([]);
  });

  it("filters the reserved ones and keeps the rest", () => {
    expect(
      safeWebhookHeaders({
        "X-Trajetto-Signature": "forged",
        Authorization: "Bearer theirs",
        "X-Api-Key": "abc",
      }),
    ).toEqual({ Authorization: "Bearer theirs", "X-Api-Key": "abc" });
  });

  it("protects the signature, which is the published guarantee", () => {
    // A customer who replaced the signature with any value they liked would
    // turn a shared receiver into a replay target.
    expect(RESERVED_WEBHOOK_HEADERS.has("x-trajetto-signature")).toBe(true);
    expect(RESERVED_WEBHOOK_HEADERS.has("host")).toBe(true);
  });

  it("accepts the map being absent", () => {
    expect(safeWebhookHeaders(null)).toEqual({});
    expect(safeWebhookHeaders(undefined)).toEqual({});
  });
});
