// @vitest-environment node
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { infraUrl } from "./support/infra-urls";

/**
 * The trajetto-postgres image ready for a standby (plano-escala F4-40,
 * the security review), on the real network of the infra phase
 * (tests/E2E/infra/run.sh).
 *
 * The primary runs with POSTGRES_REPLICATION_CIDR set to the standby's
 * address alone (/32), so its pg_hba is the official rules plus one line:
 * replication, trajetto_replication, that address, scram-sha-256. The
 * standby is cloned and started by the image's standby branch. What must
 * hold: the stream comes from inside the CIDR; the same login, with the
 * right password, is refused from anywhere else (this machine reaches the
 * published port from the network's gateway); the primary accepts every
 * ordinary connection it accepted before (the runtime through PgBouncer
 * and the superuser here are those); and the password never leaves the
 * standby's passfile.
 */
const PRIMARY = infraUrl("primary");
const STANDBY = infraUrl("standby");
const REPLICATION = infraUrl("replication");

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

describe("the primary's pg_hba", () => {
  it("is the image's: the official rules plus one replication line, for the standby's address alone", async () => {
    const { rows: file } = await primary.query<{ hba_file: string }>(
      "SHOW hba_file",
    );
    const { rows } = await primary.query<{ rule: string }>(
      `SELECT concat_ws(' ', type, array_to_string(database, ','),
                        array_to_string(user_name, ','), address, netmask,
                        auth_method) AS rule
         FROM pg_hba_file_rules
        WHERE error IS NULL
        ORDER BY line_number`,
    );
    const { rows: sender } = await primary.query<{ address: string }>(
      `SELECT host(client_addr) AS address FROM pg_stat_replication
        WHERE usename = 'trajetto_replication' AND state = 'streaming'`,
    );

    expect(file[0].hba_file).toBe("/etc/trajetto/run/pg_hba.conf");
    expect(sender).toHaveLength(1);
    expect(rows.map((row) => row.rule)).toEqual([
      "local all all trust",
      "host all all 127.0.0.1 255.255.255.255 trust",
      "host all all ::1 ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff trust",
      "local replication all trust",
      "host replication all 127.0.0.1 255.255.255.255 trust",
      "host replication all ::1 ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff trust",
      "host all all all scram-sha-256",
      // The stream comes from this very address: inside the CIDR.
      `host replication trajetto_replication ${sender[0].address} 255.255.255.255 scram-sha-256`,
    ]);
  });

  it("refuses the replication login from outside that address, even with the right password", async () => {
    const outsider = new pg.Client({
      connectionString: REPLICATION,
      replication: "true",
    } as pg.ClientConfig);

    await expect(outsider.connect()).rejects.toMatchObject({
      code: "28000",
      message: expect.stringMatching(
        /no pg_hba\.conf entry for replication connection from host "[^"]+", user "trajetto_replication"/,
      ),
    });
  });
});

describe("the standby, cloned by the image's standby branch", () => {
  it("follows the primary as trajetto_replication, with the password in its passfile only", async () => {
    const { rows } = await standby.query<{
      recovering: boolean;
      conninfo: string;
      slot: string;
      feedback: string;
      status: string;
    }>(
      `SELECT pg_is_in_recovery() AS recovering,
              current_setting('primary_conninfo') AS conninfo,
              current_setting('primary_slot_name') AS slot,
              current_setting('hot_standby_feedback') AS feedback,
              (SELECT status FROM pg_stat_wal_receiver) AS status`,
    );

    expect(rows[0]).toMatchObject({
      recovering: true,
      slot: "e2e_infra_standby",
      feedback: "off",
      status: "streaming",
    });
    expect(rows[0].conninfo).toContain(
      "port=5432 user=trajetto_replication passfile=/etc/trajetto/run/replication.pgpass application_name=trajetto-standby",
    );
    expect(rows[0].conninfo).not.toMatch(/password/i);

    // Nothing of the clone on the volume: no -R, no primary_conninfo there.
    const { rows: auto } = await standby.query<{ text: string }>(
      "SELECT pg_read_file('postgresql.auto.conf') AS text",
    );

    expect(auto[0].text).not.toContain("primary_conninfo");
  });
});
