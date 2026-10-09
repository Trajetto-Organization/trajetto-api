import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The scheduled, off-host backup (INFRA-01), executed with every external
 * tool stubbed: pg_dump, pg_restore, age, rclone, curl and date.
 *
 * Until this existed, the only backup was a manual script writing to the same
 * host as the database — no schedule, no copy elsewhere — while five jobs
 * delete data every night (03:17 to 04:10 UTC, one of them DROPping trail
 * partitions). A disk failure, a `docker volume rm` or a wrong purge predicate
 * was unrecoverable.
 *
 * What must hold: a bad dump is never uploaded, nothing leaves the container
 * unencrypted (the dump holds every tenant's personal data), nothing is left
 * on disk, and every outcome reaches the heartbeat — silence is what the
 * dead-man switch alerts on.
 */
const sh = hasShell("sh");

const THURSDAY = "2026 09 24 4 023000";
const SUNDAY = "2026 10 04 7 023000";
const FIRST_SUNDAY = "2026 11 01 7 023000";

let box: Sandbox;
let tmp: string;

beforeEach(() => {
  box = sandbox();
  tmp = `${box.root}/tmp`;
  mkdirSync(tmp);

  box.stub(
    "pg_dump",
    `out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-f" ]; then out="$2"; fi
  shift
done
head -c "\${STUB_DUMP_BYTES:-4096}" /dev/zero | tr '\\0' 'x' > "$out"
exit "\${STUB_DUMP_EXIT:-0}"`,
  );
  box.stub("pg_restore", `exit "\${STUB_TOC_EXIT:-0}"`);
  box.stub(
    "age",
    `out=""; last=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift; fi
  last="$1"
  shift
done
cp "$last" "$out"`,
  );
  box.stub(
    "rclone",
    `printf '%s\\n' "endpoint=$RCLONE_CONFIG_R2_ENDPOINT provider=$RCLONE_CONFIG_R2_PROVIDER" >> "${box.root}/rclone-env.log"
exit "\${STUB_RCLONE_EXIT:-0}"`,
  );
  box.stub("curl", "exit 0");
  box.stub("date", `echo "\${STUB_DATE:-${THURSDAY}}"`);
});

afterEach(() => box.dispose());

const config = {
  PGHOST: "trajetto-database",
  PGUSER: "trajetto",
  PGPASSWORD: "secret",
  PGDATABASE: "trajetto",
  BACKUP_R2_ACCOUNT_ID: "acc123",
  BACKUP_R2_BUCKET: "trajetto-prod-backups",
  BACKUP_R2_ACCESS_KEY_ID: "key",
  BACKUP_R2_SECRET_ACCESS_KEY: "secret-key",
  BACKUP_AGE_RECIPIENT: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
  BACKUP_HEARTBEAT_URL: "https://hc-ping.com/uuid",
};

function backup(env: Record<string, string> = {}) {
  const result = run("sh", repoFile("infra/backup/backup-to-r2.sh"), [], {
    bin: box.bin,
    env: { ...config, TMPDIR: tmp, ...env },
  });

  const uploads = box
    .calls("rclone")
    .filter((call) => call.startsWith("rclone copyto"))
    .map((call) => call.split(" ").slice(2));

  return { ...result, uploads, pings: box.calls("curl") };
}

describe.skipIf(!sh)("the nightly backup", () => {
  it("uploads the encrypted dump and its checksum under the day, and says so", () => {
    const { status, stdout, stderr, uploads, pings } = backup();

    expect(status, stdout + stderr).toBe(0);

    const destinations = uploads.map(([, to]) => to);

    expect(destinations).toEqual([
      expect.stringMatching(
        /^r2:trajetto-prod-backups\/pg\/daily\/2026\/09\/24\/trajetto-\d{8}T\d{6}Z\.dump\.age$/,
      ),
      expect.stringMatching(
        /^r2:trajetto-prod-backups\/pg\/daily\/2026\/09\/24\/trajetto-\d{8}T\d{6}Z\.dump\.age\.sha256$/,
      ),
    ]);

    expect(pings).toHaveLength(1);
    expect(pings[0]).toContain("https://hc-ping.com/uuid");
    expect(pings[0]).not.toContain("/fail");
  });

  it("never uploads a plaintext dump", () => {
    const { uploads } = backup();

    for (const [from, to] of uploads) {
      expect(from).not.toMatch(/\.dump$/);
      expect(to).not.toMatch(/\.dump$/);
    }
  });

  it("talks to R2 with the backup bucket's own account", () => {
    backup();

    expect(readFileSync(`${box.root}/rclone-env.log`, "utf8")).toContain(
      "endpoint=https://acc123.r2.cloudflarestorage.com provider=Cloudflare",
    );
  });

  it("leaves nothing on disk: the dump holds every tenant's data", () => {
    backup();

    expect(readdirSync(tmp)).toEqual([]);
  });

  it("keeps a weekly copy on Sundays and a monthly one on the 1st", () => {
    const sunday = backup({ STUB_DATE: SUNDAY }).uploads.map(([, to]) => to);

    expect(sunday.filter((to) => to.includes("/pg/weekly/2026/10/04/"))).toHaveLength(2);
    expect(sunday.filter((to) => to.includes("/pg/monthly/"))).toHaveLength(0);

    box.dispose();
    box = sandbox();
    box.stub("rclone", "exit 0");
    for (const name of ["pg_restore", "curl"]) box.stub(name, "exit 0");
    box.stub(
      "pg_dump",
      `while [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then head -c 4096 /dev/zero > "$2"; fi; shift; done`,
    );
    box.stub(
      "age",
      `out=""; last=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; last="$1"; shift; done; cp "$last" "$out"`,
    );
    box.stub("date", `echo "${FIRST_SUNDAY}"`);
    tmp = `${box.root}/tmp`;
    mkdirSync(tmp);

    const first = backup().uploads.map(([, to]) => to);

    expect(first.filter((to) => to.includes("/pg/monthly/2026/11/01/"))).toHaveLength(2);
    expect(first.filter((to) => to.includes("/pg/weekly/2026/11/01/"))).toHaveLength(2);
  });

  it.each([
    ["a dump too small to be one", { STUB_DUMP_BYTES: "10" }],
    ["pg_dump failing", { STUB_DUMP_EXIT: "1" }],
    ["a table of contents that does not read back", { STUB_TOC_EXIT: "1" }],
  ])("uploads nothing and reports a failure on %s", (_, env) => {
    const { status, uploads, pings } = backup(env);

    expect(status).not.toBe(0);
    expect(uploads).toEqual([]);
    expect(pings.some((call) => call.includes("https://hc-ping.com/uuid/fail"))).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("reports a failed upload as a failure", () => {
    const { status, pings } = backup({ STUB_RCLONE_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(pings.some((call) => call.includes("/fail"))).toBe(true);
  });

  it("leaves the trail's rows out only when told to (PG-11)", () => {
    backup();
    expect(box.calls("pg_dump")[0]).not.toContain("driver_position");

    backup({ BACKUP_EXCLUDE_TRAIL: "true" });
    expect(box.calls("pg_dump")[1]).toContain(
      "--exclude-table-data-and-children=public.driver_position",
    );
  });

  it("refuses to run half-configured, before touching the database", () => {
    const { status, pings } = backup({ BACKUP_AGE_RECIPIENT: "" });

    expect(status).not.toBe(0);
    expect(box.calls("pg_dump")).toEqual([]);
    expect(pings.some((call) => call.includes("/fail"))).toBe(true);
  });
});

describe.skipIf(!sh)("when the nightly backup runs", () => {
  const wait = (at: string, now: number) =>
    run("sh", repoFile("infra/backup/backup-loop.sh"), ["--seconds-until", at, String(now)])
      .stdout.trim();

  const utc = (hh: number, mm: number, ss = 0) =>
    Date.UTC(2026, 8, 24, hh, mm, ss) / 1000;

  it("waits for the configured UTC time today when it is still ahead", () => {
    expect(wait("02:30", utc(1, 0))).toBe("5400");
    expect(wait("08:05", utc(8, 0))).toBe("300");
  });

  it("waits for tomorrow once today's time has passed", () => {
    expect(wait("02:30", utc(3, 0))).toBe(String(23.5 * 3600));
  });

  it("never busy-loops at the exact second", () => {
    expect(wait("02:30", utc(2, 30))).toBe("86400");
  });
});

describe("the backup service in the production stack", () => {
  const compose = readFileSync(resolve(process.cwd(), "compose.production.yaml"), "utf8")
    .replace(/\r\n/g, "\n");
  const start = compose.indexOf("\n  trajetto-backup:\n");
  const rest = compose.slice(start + 1);
  const block = start < 0 ? "" : rest.slice(0, rest.slice(1).search(/\n(  [\w-]+:\n|\S)/) + 1);

  it("exists, built from this repository", () => {
    expect(block, "serviço trajetto-backup").toMatch(
      /image: ghcr\.io\/trajetto-organization\/trajetto-backup:\$\{BACKUP_IMAGE_TAG:-stable\}/,
    );
  });

  it("runs before the first nightly job that deletes data (03:17 UTC)", () => {
    const at = block.match(/BACKUP_AT_UTC: "\$\{BACKUP_AT_UTC:-(\d{2}):(\d{2})\}"/);

    expect(at, "BACKUP_AT_UTC").not.toBeNull();
    expect(Number(at![1]) * 60 + Number(at![2])).toBeLessThan(3 * 60 + 17);
  });

  it("cannot be deployed without somewhere to send the backup", () => {
    for (const name of [
      "BACKUP_R2_ACCOUNT_ID",
      "BACKUP_R2_BUCKET",
      "BACKUP_R2_ACCESS_KEY_ID",
      "BACKUP_R2_SECRET_ACCESS_KEY",
      "BACKUP_AGE_RECIPIENT",
      "BACKUP_HEARTBEAT_URL",
    ]) {
      expect(block, name).toMatch(new RegExp(`${name}: \\$\\{${name}:\\?[^}]+\\}`));
    }
  });

  it("dumps over the network, with no access to the Docker daemon", () => {
    // The manual script needs `docker exec`; a sidecar with the socket
    // mounted would be root on the host for whoever compromised it.
    expect(compose).not.toContain("docker.sock");
    expect(block).toMatch(/PGHOST: /);
  });

  it("is built and promoted with the API", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), ".github", "workflows", "deploy.yml"),
      "utf8",
    );

    expect(workflow).toMatch(/context: \.\/infra\/backup/);
    expect(workflow).toContain("ghcr.io/trajetto-organization/trajetto-backup");
  });
});
