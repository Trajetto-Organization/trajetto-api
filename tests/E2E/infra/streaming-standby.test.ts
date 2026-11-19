// @vitest-environment node
import { randomBytes } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { infraUrl } from "./support/infra-urls";

/**
 * The real standby of the E2E infra phase (plano-escala F4-38;
 * tests/E2E/infra/run.sh): a pg_basebackup of the stack's primary,
 * streaming through a physical slot as trajetto_replication, a login with
 * REPLICATION that pg_hba.conf accepts from the stack's network only.
 *
 * What the files that read from a standby build on (the replica-guard and
 * the reads it routes, wave 17): it is in recovery, it refuses writes, and
 * a commit on the primary shows up on it.
 */
const PRIMARY = infraUrl("primary");
const STANDBY = infraUrl("standby");

let primary: pg.Client;
let standby: pg.Client;

beforeAll(async () => {
  primary = new pg.Client({ connectionString: PRIMARY });
  standby = new pg.Client({ connectionString: STANDBY });
  await primary.connect();
  await standby.connect();
});

afterAll(async () => {
  await standby.end();
  await primary.end();
});

describe("the standby of the infra phase", () => {
  it("streams from the primary as trajetto_replication, through its slot", async () => {
    // The standby of the slot: the failover file's own standby streams
    // without one, and may already be promoted.
    const { rows: senders } = await primary.query<{
      usename: string;
      state: string;
    }>(
      `SELECT r.usename, r.state FROM pg_stat_replication r
         JOIN pg_replication_slots s ON s.active_pid = r.pid`,
    );
    const { rows: slots } = await primary.query<{
      slot_type: string;
      active: boolean;
    }>("SELECT slot_type, active FROM pg_replication_slots");

    expect(senders).toEqual([
      { usename: "trajetto_replication", state: "streaming" },
    ]);
    expect(slots).toEqual([{ slot_type: "physical", active: true }]);
  });

  it("is in recovery and refuses a write", async () => {
    const { rows } = await standby.query<{ recovering: boolean }>(
      "SELECT pg_is_in_recovery() AS recovering",
    );

    expect(rows[0].recovering).toBe(true);
    await expect(
      standby.query("CREATE TABLE e2e_infra_refused (id int)"),
    ).rejects.toMatchObject({ code: "25006" });
  });

  it("shows a commit of the primary", async () => {
    const table = `e2e_infra_probe_${randomBytes(4).toString("hex")}`;
    const marker = randomBytes(8).toString("hex");

    await primary.query(`CREATE TABLE ${table} (marker text NOT NULL)`);

    try {
      await primary.query(`INSERT INTO ${table} (marker) VALUES ($1)`, [
        marker,
      ]);

      const { rows } = await primary.query<{ lsn: string }>(
        "SELECT pg_current_wal_lsn()::text AS lsn",
      );

      await vi.waitFor(
        async () => {
          const replayed = await standby.query<{ caught_up: boolean }>(
            "SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS caught_up",
            [rows[0].lsn],
          );

          expect(replayed.rows[0].caught_up).toBe(true);
        },
        { timeout: 20_000, interval: 100 },
      );

      const copy = await standby.query<{ marker: string }>(
        `SELECT marker FROM ${table}`,
      );

      expect(copy.rows).toEqual([{ marker }]);
    } finally {
      await primary.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }, 30_000);
});
