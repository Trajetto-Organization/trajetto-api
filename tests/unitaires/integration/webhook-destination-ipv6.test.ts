import { describe, expect, it } from "vitest";

import { isPrivateAddress } from "@/shared/integration/webhook-destination";

/**
 * The IPv6 forms that carry, or hide, a private address.
 *
 * The check read the text: "starts with fe80", "is ::ffff:a.b.c.d". Every form
 * below slipped past it and was classified public — the IPv4-compatible
 * `::127.0.0.1`, the NAT64 and 6to4 prefixes that embed an IPv4 a gateway
 * translates back, and the rest of fe80::/10 beyond its first textual prefix.
 * On a host with NAT64 or 6to4 enabled, an AAAA record on one of them reaches
 * 10.0.0.5.
 */
describe("IPv6 addresses that reach a private network", () => {
  it.each([
    ["::127.0.0.1", "IPv4-compatible loopback"],
    ["::a00:5", "IPv4-compatible, hex"],
    ["64:ff9b::a00:5", "NAT64 of 10.0.0.5"],
    ["64:ff9b::10.0.0.5", "NAT64, dotted"],
    ["64:ff9b:1::1", "local-use NAT64"],
    ["fe90::1", "link-local past the fe80 text"],
    ["febf::1", "end of fe80::/10"],
    ["fec0::1", "site-local"],
    ["2002:a00:5::1", "6to4 of 10.0.0.5"],
    ["2002:a9fe:a9fe::1", "6to4 of the metadata address"],
    ["::ffff:a00:5", "mapped, hex"],
    ["::ffff:0:a00:5", "IPv4-translated"],
    ["2001:db8::1", "documentation"],
    ["2001::1", "Teredo"],
    ["100::1", "discard"],
    ["FE80::1%eth0", "link-local with a zone, upper case"],
    ["ff02::1", "multicast"],
  ])("refuses %s (%s)", (address) => {
    expect(isPrivateAddress(address), address).toBe(true);
  });
});

describe("IPv6 addresses that are a customer", () => {
  it.each([
    ["2606:4700::1111", "a public host"],
    ["2001:4860:4860::8888", "another public host"],
    ["64:ff9b::808:808", "NAT64 of a public IPv4 (DNS64)"],
    ["2002:808:808::1", "6to4 of a public IPv4"],
    ["::ffff:8.8.8.8", "mapped public IPv4"],
  ])("accepts %s (%s)", (address) => {
    expect(isPrivateAddress(address), address).toBe(false);
  });
});
