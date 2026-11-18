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

  it("leaves a limit too low for the reserve out, and says so", () => {
    // 1,024 descriptors minus 1,024 would be no realtime at all: a
    // misconfigured host warns at boot instead of refusing every socket.
    expect(
      effectiveSocketCap({
        maxConnections: 5_000,
        fdLimit: 1_024 + FD_CAP_MIN - 1,
        fdReserve: 1_024,
      }),
    ).toMatchObject({ cap: 5_000, source: "connections", fdTooLow: true });
  });

  it("keeps the descriptors with the setting off, and nothing with both off", () => {
    expect(
      effectiveSocketCap({
        maxConnections: 0,
        fdLimit: 8_192,
        fdReserve: 1_024,
      }),
    ).toMatchObject({ cap: 7_168, source: "descriptors" });
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
