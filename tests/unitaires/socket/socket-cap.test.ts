import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERT_THRESHOLDS,
  collectAlerts,
  type OperationalSnapshot,
} from "@/shared/health/alert-rules";
import {
  FD_CAP_MIN,
  effectiveSocketCap,
  parseOpenFilesSoftLimit,
  readOpenFilesSoftLimit,
} from "@/shared/socket/socket-cap";

/**
 * The replica's real socket ceiling (plano-escala F5-31).
 *
 * Every websocket is a file descriptor, and so is every Postgres
 * connection, Redis client and HTTP keep-alive. SOCKET_MAX_CONNECTIONS said
 * 5,000 whatever the process was allowed, and under a lower descriptor
 * limit the sockets would take the last descriptors: the next Postgres
 * connect failing with EMFILE is the whole replica down, not a refused
 * handshake. So the ceiling is min(setting, fd_soft − reserve), and the
 * ops heartbeat pages at 80% of it.
 */
const LIMITS = `Limit                     Soft Limit           Hard Limit           Units
Max cpu time              unlimited            unlimited            seconds
Max file size             unlimited            unlimited            bytes
Max open files            524288               524288               files
Max locked memory         8388608              8388608              bytes
`;

describe("the descriptor limit", () => {
  it("is the soft open-files limit of /proc/self/limits", () => {
    expect(parseOpenFilesSoftLimit(LIMITS)).toBe(524_288);
    expect(
      parseOpenFilesSoftLimit(
        LIMITS.replace("524288               524288", "4096 1048576"),
      ),
    ).toBe(4_096);
  });

  it("is unknown when unlimited, absent or unreadable", () => {
    expect(
      parseOpenFilesSoftLimit(
        LIMITS.replace(
          "524288               524288",
          "unlimited            unlimited",
        ),
      ),
    ).toBeNull();
    expect(parseOpenFilesSoftLimit("nada aqui")).toBeNull();
    expect(
      readOpenFilesSoftLimit(() => {
        throw new Error("ENOENT: not Linux");
      }),
    ).toBeNull();
    expect(readOpenFilesSoftLimit(() => LIMITS)).toBe(524_288);
  });
});

describe("the ceiling", () => {
  it("is the setting while the descriptors leave room for it", () => {
    expect(
      effectiveSocketCap({
        maxConnections: 5_000,
        fdLimit: 524_288,
        fdReserve: 1_024,
      }),
    ).toEqual({
      cap: 5_000,
      fdLimit: 524_288,
      source: "connections",
      fdTooLow: false,
    });
  });

  it("drops to the descriptors minus the reserve when they are fewer", () => {
    // The container's soft limit at 4,096: 3,072 sockets, not 5,000.
    expect(
      effectiveSocketCap({
        maxConnections: 5_000,
        fdLimit: 4_096,
        fdReserve: 1_024,
      }),
    ).toMatchObject({ cap: 3_072, source: "descriptors" });
  });

  it("never goes back to the setting on a limit too low for the reserve", () => {
    // That is the host where the sockets do run the process out of
    // descriptors: 1,900 sockets admitted under 2,000, and the next
    // Postgres connect fails with EMFILE, the whole replica down. The
    // reserve shrinks instead: 1,024 sockets, or half the descriptors on a
    // host with fewer than 2,048, and the boot warns.
    expect(
      effectiveSocketCap({
        maxConnections: 5_000,
        fdLimit: 2_000,
        fdReserve: 1_024,
      }),
    ).toEqual({
      cap: 1_000,
      fdLimit: 2_000,
      source: "descriptors",
      fdTooLow: true,
    });
    expect(
      effectiveSocketCap({
        maxConnections: 5_000,
        fdLimit: 1_024 + FD_CAP_MIN - 1,
        fdReserve: 1_024,
      }),
    ).toMatchObject({ cap: 1_023, source: "descriptors", fdTooLow: true });

    // 1,024 minus 1,024 would be no realtime at all; half of it is some.
    expect(
      effectiveSocketCap({
        maxConnections: 5_000,
        fdLimit: 1_024,
        fdReserve: 1_024,
      }),
    ).toMatchObject({ cap: 512, source: "descriptors", fdTooLow: true });

    // A big reserve on a big host keeps most of it: 1,024 sockets.
    expect(
      effectiveSocketCap({
        maxConnections: 5_000,
        fdLimit: 4_500,
        fdReserve: 4_096,
      }),
    ).toMatchObject({ cap: 1_024, source: "descriptors", fdTooLow: true });

    // Never 0, which the admission reads as no ceiling at all.
    expect(
      effectiveSocketCap({ maxConnections: 5_000, fdLimit: 1, fdReserve: 1 }),
    ).toMatchObject({ cap: 1, source: "descriptors" });
  });

  it("keeps the setting when it is the smaller, even on a low limit", () => {
    expect(
      effectiveSocketCap({
        maxConnections: 300,
        fdLimit: 1_024,
        fdReserve: 1_024,
      }),
    ).toMatchObject({ cap: 300, source: "connections", fdTooLow: true });
  });

  it("is off, descriptors included, with the setting at 0: the rollback", () => {
    // SOCKET_MAX_CONNECTIONS=0 is the documented rollback of the ceiling.
    // Keeping the descriptors' part under it, a replica with fd_soft at
    // 4,096 still refused at 3,072 sockets, and the rollback did nothing.
    for (const fdLimit of [4_096, 8_192, 524_288]) {
      expect(
        effectiveSocketCap({ maxConnections: 0, fdLimit, fdReserve: 1_024 }),
        String(fdLimit),
      ).toEqual({ cap: 0, fdLimit, source: "off", fdTooLow: false });
    }
    expect(
      effectiveSocketCap({ maxConnections: 0, fdLimit: 8_192, fdReserve: 0 }),
    ).toMatchObject({ cap: 0, source: "off" });
    expect(
      effectiveSocketCap({
        maxConnections: 0,
        fdLimit: null,
        fdReserve: 1_024,
      }),
    ).toMatchObject({ cap: 0, source: "off" });
  });

  it("is the setting alone off Linux", () => {
    expect(
      effectiveSocketCap({
        maxConnections: 5_000,
        fdLimit: null,
        fdReserve: 1_024,
      }),
    ).toEqual({
      cap: 5_000,
      fdLimit: null,
      source: "connections",
      fdTooLow: false,
    });
  });
});

describe("the socket-cap-high alert", () => {
  const snapshot = (
    sockets: OperationalSnapshot["sockets"],
  ): OperationalSnapshot => ({
    now: new Date("2026-11-17T12:00:00Z"),
    outboxEligibleLagSec: null,
    deliveryEligibleLagSec: { internal: null, external: null },
    webhookDueLagSec: null,
    aiEligibleLagSec: null,
    deliveryFailures: [],
    aiCredentialFailures: 0,
    cronJobs: [],
    partitionRunwayOk: true,
    partitionRunwayDays: 7,
    stuckWorkers: [],
    connectionUsagePercent: 10,
    redisOk: true,
    sockets,
    collectionErrors: [],
  });

  const codes = (value: OperationalSnapshot) =>
    collectAlerts(value, DEFAULT_ALERT_THRESHOLDS, {
      pitrExpected: false,
    }).map((alert) => alert.code);

  it("pages for the replica at 80% of its ceiling, naming it", () => {
    const alerts = collectAlerts(
      snapshot([
        { replica: "api-1", connections: 4_000, cap: 5_000 },
        { replica: "api-2", connections: 3_950, cap: 5_000 },
      ]),
      DEFAULT_ALERT_THRESHOLDS,
      { pitrExpected: false },
    );

    expect(alerts).toEqual([
      {
        code: "socket-cap-high",
        message:
          "Sockets na réplica api-1: 4000 de 5000 (80% do teto, limite 80%)",
      },
    ]);
  });

  it("judges each replica against its own ceiling", () => {
    // 2,500 sockets is 81% of a ceiling lowered by the descriptors.
    expect(
      codes(snapshot([{ replica: "api-3", connections: 2_500, cap: 3_072 }])),
    ).toEqual(["socket-cap-high"]);
  });

  it("never judges a replica without a ceiling, nor a snapshot without the rows", () => {
    expect(
      codes(snapshot([{ replica: "api-1", connections: 9_000, cap: 0 }])),
    ).toEqual([]);
    expect(codes(snapshot(undefined))).toEqual([]);
  });
});
