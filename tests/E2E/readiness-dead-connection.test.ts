import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SilentProxy, settle } from "./support/silent-proxy";

/**
 * The readiness probe gets over a connection that died in silence (GAP6-5
 * with GAP6-4).
 *
 * The probe runs `SELECT 1` on a client of its own with ONE connection
 * (OBS-11), so a saturated main pool cannot take the replica out. But when
 * that one connection's peer vanishes without a FIN or RST — the database
 * task lost with its node and rescheduled, a partition — every later probe
 * went out on the same dead socket: socket_timeout ends the query, and hands
 * the connection back to be used again. The replica answered "not ready"
 * until the kernel gave up on the socket (~15 min), with the database back
 * and answering, and Traefik kept it out all that time — both replicas, since
 * both lost the same flow.
 *
 * A proxy between the probe and Postgres forgets the open flows; flows opened
 * afterwards work, the way a database back on a new address does.
 */
const originalUrl = process.env.DATABASE_URL as string;

let proxy: SilentProxy;
let probe: typeof import("@/shared/health/readiness-probe");

beforeAll(async () => {
  proxy = SilentProxy.for(originalUrl);
  const port = await proxy.listen();

  const throughProxy = new URL(originalUrl);
  throughProxy.hostname = "127.0.0.1";
  throughProxy.port = String(port);

  // The probe builds its client from DATABASE_URL on first use.
  process.env.DATABASE_URL = throughProxy.toString();

  probe = await import("@/shared/health/readiness-probe");
});

afterAll(async () => {
  await proxy.close();
  process.env.DATABASE_URL = originalUrl;
});

describe("readiness after its connection dies in silence", () => {
  it(
    "says no while the connection is dead, then yes on a fresh one",
    { timeout: 20_000 },
    async () => {
      expect(await probe.probeDatabase()).toBe(true);

      proxy.forgetOpenFlows();

      // The dead connection: a "no", within the probe's own timeout.
      const dead = await settle(
        probe.probeDatabase(),
        probe.READINESS_TIMEOUT_MS + 1_000,
      );

      expect(dead).toMatchObject({ kind: "answered", value: false });

      // The database never went anywhere. The next probe must not go out on
      // the same dead socket again.
      const next = await settle(probe.probeDatabase(), 2_500);

      expect(next).toMatchObject({ kind: "answered", value: true });
      expect(next.ms).toBeLessThan(1_500);
    },
  );
});
