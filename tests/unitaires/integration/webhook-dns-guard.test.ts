import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The name resolution of a webhook destination.
 *
 * It went through `dns.lookup`: getaddrinfo on libuv's four-thread pool —
 * the same four threads bcrypt uses for every login — with no timeout of its
 * own. A customer's authoritative server that never answers held a thread for
 * the whole resolver timeout, twice per attempt (the check, then the fetch
 * resolving again by itself).
 *
 * The resolver here is a stub: this file never reaches a real DNS server.
 */
const dns = vi.hoisted(() => {
  const state = {
    mode: "never" as "never" | "answers",
    answers: new Map<string, string[][]>(),
    asked: [] as string[],
  };

  const never = () => new Promise<never>(() => undefined);

  const answer = async (host: string, family: 4 | 6) => {
    state.asked.push(host);

    if (state.mode === "never") return never();

    const queue = state.answers.get(host) ?? [];
    const next = (queue.length > 1 ? queue.shift() : queue[0]) ?? [];
    const matching = next.filter((address) =>
      family === 4 ? !address.includes(":") : address.includes(":"),
    );

    if (matching.length === 0) {
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    }

    return matching;
  };

  class Resolver {
    resolve4 = (host: string) => answer(host, 4);
    resolve6 = (host: string) => answer(host, 6);
    setServers() {}
    cancel() {}
  }

  const lookup = async (host: string) => {
    state.asked.push(host);
    return never();
  };

  return { state, Resolver, lookup };
});

vi.mock("node:dns/promises", () => ({
  default: { lookup: dns.lookup, Resolver: dns.Resolver },
  lookup: dns.lookup,
  Resolver: dns.Resolver,
}));

import * as destination from "@/shared/integration/webhook-destination";

beforeEach(() => {
  dns.state.mode = "never";
  dns.state.answers.clear();
  dns.state.asked.length = 0;
});

describe("a resolver that never answers", () => {
  it("gives a verdict in bounded time, instead of holding a thread", async () => {
    const started = Date.now();

    const verdict = await destination.verifyWebhookDestination(
      "https://slow.exemplo.com.br/hook",
    );

    expect(verdict).toMatchObject({ allowed: false, transient: true });
    expect(Date.now() - started).toBeLessThan(3_500);
  }, 6_000);
});

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

function callLookup(
  lookup: (hostname: string, options: object, callback: LookupCallback) => void,
  hostname: string,
  options: object,
): Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family: unknown }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) =>
      resolve({ error, address, family }),
    );
  });
}

describe("the address the connection uses", () => {
  it("is the one that was checked, resolved once at connect time", async () => {
    // DNS rebinding: the attacker's name answers a public address to the
    // check and a private one a moment later, to the connection.
    const answers = [["93.184.216.34"], ["10.0.0.5"]];
    const resolve = vi.fn(async () => answers.shift() ?? []);

    const lookup = destination.createGuardedLookup(resolve);

    const first = await callLookup(lookup, "rebind.exemplo.com.br", { all: true });

    expect(first.error).toBeNull();
    expect(first.address).toEqual([{ address: "93.184.216.34", family: 4 }]);

    const second = await callLookup(lookup, "rebind.exemplo.com.br", { all: true });

    expect(second.error?.code).toBe("EWEBHOOK_FORBIDDEN");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("refuses the whole name when any of its addresses is private", async () => {
    const lookup = destination.createGuardedLookup(async () => [
      "93.184.216.34",
      "::1",
    ]);

    const result = await callLookup(lookup, "mixed.exemplo.com.br", {});

    expect(result.error?.code).toBe("EWEBHOOK_FORBIDDEN");
  });

  it("answers in the shape the socket asked for", async () => {
    const lookup = destination.createGuardedLookup(async () => [
      "2606:4700::1111",
      "93.184.216.34",
    ]);

    const single = await callLookup(lookup, "dual.exemplo.com.br", {});

    expect(single.error).toBeNull();
    expect(typeof single.address).toBe("string");
    expect([4, 6]).toContain(single.family);

    const onlyV4 = await callLookup(lookup, "dual.exemplo.com.br", { family: 4 });

    expect(onlyV4.address).toBe("93.184.216.34");
    expect(onlyV4.family).toBe(4);
  });

  it("reports a name that does not resolve as transient, not forbidden", async () => {
    const lookup = destination.createGuardedLookup(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });

    const result = await callLookup(lookup, "gone.exemplo.com.br", { all: true });

    expect(result.error?.code).toBe("EWEBHOOK_UNRESOLVED");
  });
});

describe("the resolver the check uses", () => {
  it("resolves both families and returns every address", async () => {
    dns.state.mode = "answers";
    dns.state.answers.set("dual.exemplo.com.br", [
      ["93.184.216.34", "2606:4700::1111"],
    ]);

    await expect(
      destination.resolveHost("dual.exemplo.com.br"),
    ).resolves.toEqual(["93.184.216.34", "2606:4700::1111"]);
  });
});
