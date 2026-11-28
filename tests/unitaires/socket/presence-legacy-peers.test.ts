import { describe, expect, it, vi } from "vitest";

import {
  LEGACY_PEERS_CACHE_MS,
  createLegacyPeerCheck,
} from "@/shared/socket/presence";

/**
 * When the chat's thread list asks the cluster on top of the beats
 * (plano-escala U-05).
 *
 * The image before U-05 holds sockets and never beats presence, so during
 * the rolling deploy that ships U-05 its drivers read offline on the new
 * replicas. The list asks the cluster again only while the adapter has
 * more servers than live processes beating presence; once every socket
 * process beats, it never does, which is the whole point of U-05 (the
 * E2E socket-presence-grace proves the old replica's driver is seen).
 */
function check(servers: number | Error, beating: number | Error) {
  let clock = 0;
  const serverCount = vi.fn(async () => {
    if (servers instanceof Error) throw servers;
    return servers;
  });
  const beatingSocketProcesses = vi.fn(async () => {
    if (beating instanceof Error) throw beating;
    return beating;
  });

  return {
    legacy: createLegacyPeerCheck({
      serverCount,
      beatingSocketProcesses,
      now: () => clock,
    }),
    serverCount,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("the legacy socket peers check", () => {
  it("is false once every server of the adapter beats presence", async () => {
    expect(await check(2, 2).legacy()).toBe(false);
  });

  it("is true while a server does not beat: the old image mid-roll", async () => {
    expect(await check(3, 2).legacy()).toBe(true);
  });

  it("is true when a read fails: a wrong offline is what the SAC sees", async () => {
    expect(await check(new Error("redis"), 2).legacy()).toBe(true);
    expect(await check(2, new Error("database")).legacy()).toBe(true);
  });

  it("reads again only after its cache, one read for concurrent callers", async () => {
    const { legacy, serverCount, advance } = check(2, 2);

    await Promise.all([legacy(), legacy(), legacy()]);
    expect(serverCount).toHaveBeenCalledTimes(1);

    advance(LEGACY_PEERS_CACHE_MS - 1);
    await legacy();
    expect(serverCount).toHaveBeenCalledTimes(1);

    advance(1);
    await legacy();
    expect(serverCount).toHaveBeenCalledTimes(2);
  });
});
