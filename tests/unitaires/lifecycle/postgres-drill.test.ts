import { existsSync, readdirSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The PITR's backup and its monthly drill, inside the trajetto-postgres
 * image (plano-escala F1-02), run with pgbackrest, docker, psql, df and
 * wget stubbed.
 *
 * What they guard against is silent: a backup that "passed" while the
 * archive queue dropped WAL (the PITR cannot reach that stretch); a drill
 * that fills the disk both productions share, or runs without a cap next to
 * production, or holds the key that can delete the backups; and a key or
 * the passphrase printed into a Schedule Job's log or a healthchecks.io
 * body. `docker build --target test infra/postgres` runs both scripts for
 * real against pgBackRest and a server; here every branch is driven on
 * purpose.
 */
const bash = hasShell("bash");

/** The last element (the lib here predates Array.prototype.at). */
const last = <T>(items: T[]): T | undefined => items[items.length - 1];

const SECRET_WRITE_KEY = "write-key-never-printed";
const SECRET_WRITE_SECRET = "write-secret-never-printed";
const SECRET_READ_KEY = "read-key-never-printed";
const SECRET_READ_SECRET = "read-secret-never-printed";
const SECRET_CIPHER = "cipher-pass-never-printed";
const PING = "https://hc-ping.example.com/0b7c2d9e";

const SECRETS = [
  SECRET_WRITE_KEY,
  SECRET_WRITE_SECRET,
  SECRET_READ_KEY,
  SECRET_READ_SECRET,
  SECRET_CIPHER,
  PING,
];

/**
 * `pgbackrest info` as 2.60.1 prints it (captured from the image). The
 * archive's newest segment can be moved, or left out (`none present`).
 */
function info(
  backups: Array<{
    type: "full" | "diff";
    label: string;
    start: string;
    stop: string;
    size?: string;
  }>,
  archiveMax: string | null = "0000000100000001000000FF",
): string {
  return [
    "stanza: trajetto",
    "    status: ok",
    "    cipher: aes-256-cbc",
    "",
    "    db (current)",
    archiveMax === null
      ? "        wal archive min/max (16): none present"
      : `        wal archive min/max (16): 000000010000000000000001/${archiveMax}`,
    "",
    ...backups.flatMap((backup) => [
      `        ${backup.type} backup: ${backup.label}`,
      "            timestamp start/stop: 2026-11-16 05:00:00+00 / 2026-11-16 05:00:07+00",
      `            wal start/stop: ${backup.start} / ${backup.stop}`,
      `            database size: ${backup.size ?? "29.3MB"}, database backup size: 29.3MB`,
      "            repo1: backup set size: 3.6MB, backup size: 3.6MB",
      "",
    ]),
  ].join("\n");
}

/** The segments a repository holds, named as pgBackRest stores them. */
function segments(from: number, to: number, skip: number[] = []): string {
  const names: string[] = [];

  for (let index = from; index <= to; index++) {
    if (skip.includes(index)) continue;
    const log = Math.floor(index / 256)
      .toString(16)
      .toUpperCase()
      .padStart(8, "0");
    const seg = (index % 256).toString(16).toUpperCase().padStart(8, "0");
    names.push(`00000001${log}${seg}-${"ab".repeat(20)}.zst`);
  }

  return names.join("\n") + "\n";
}

const seg = (index: number) =>
  `00000001${Math.floor(index / 256)
    .toString(16)
    .toUpperCase()
    .padStart(
      8,
      "0",
    )}${(index % 256).toString(16).toUpperCase().padStart(8, "0")}`;

/**
 * pgbackrest: the command is the first argument that is not an option.
 * repo-ls lists the archive ids, or the segments of one TL+LOG directory.
 */
const PGBACKREST = `
command=""
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *) if [ -z "$command" ]; then command=$arg; else path=$arg; fi ;;
  esac
done
case "$command" in
  backup) exit "\${STUB_BACKUP_EXIT:-0}" ;;
  check) exit "\${STUB_CHECK_EXIT:-0}" ;;
  info)
    if [ -n "\${STUB_INFO_ERROR:-}" ]; then echo "$STUB_INFO_ERROR" >&2; exit 1; fi
    cat "$STUB_INFO" ;;
  repo-ls)
    case "$path" in
      archive/trajetto) printf '16-1\\narchive.info\\narchive.info.copy\\n' ;;
      */*/*/*) dir=\${path##*/}; grep "^$dir" "$STUB_SEGMENTS" || true ;;
    esac ;;
  restore)
    # A cluster lands in --pg1-path, a dotfile included, even when the
    # restore then fails half-way.
    for arg in "$@"; do
      case "$arg" in --pg1-path=*) data=\${arg#--pg1-path=} ;; esac
    done
    if [ -n "\${data:-}" ]; then
      mkdir -p "$data/base/1" && echo 16 > "$data/PG_VERSION"
      : > "$data/base/1/1259"; : > "$data/.restored-dotfile"
    fi
    if [ -n "\${STUB_RESTORE_ERROR:-}" ]; then echo "$STUB_RESTORE_ERROR" >&2; exit 1; fi
    : ;;
esac
exit 0`;

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
  box.stub("pgbackrest", PGBACKREST);
  box.stub("wget", 'exit "${STUB_WGET_EXIT:-0}"');
  box.stub("curl", "exit 0");
  // Retries and polling never wait in a test.
  box.stub("sleep", "exit 0");
});

afterEach(() => box.dispose());

/** Everything the run said or sent: stdout, stderr and the ping bodies. */
function everything(result: { stdout: string; stderr: string }) {
  return `${result.stdout}\n${result.stderr}\n${box.calls().join("\n")}`;
}

const repoEnv = {
  PGBACKREST_REPO1_S3_ENDPOINT: "account.r2.example.com",
  PGBACKREST_REPO1_S3_BUCKET: "trajetto-pitr-test",
  PGBACKREST_REPO1_S3_KEY: SECRET_WRITE_KEY,
  PGBACKREST_REPO1_S3_KEY_SECRET: SECRET_WRITE_SECRET,
  PGBACKREST_REPO1_CIPHER_PASS: SECRET_CIPHER,
};

describe.skipIf(!bash)("trajetto-backup", () => {
  function backup(
    args: string[],
    {
      backups,
      present,
      env = {},
    }: {
      backups: Parameters<typeof info>[0];
      present: string;
      env?: Record<string, string>;
    },
  ) {
    return run("bash", repoFile("infra/postgres/bin/trajetto-backup"), args, {
      bin: box.bin,
      env: {
        ...repoEnv,
        PITR_BACKUP_DIFF_PING_URL: PING,
        PITR_BACKUP_FULL_PING_URL: `${PING}-full`,
        STUB_INFO: box.file("info.txt", info(backups)),
        STUB_SEGMENTS: box.file("segments.txt", present),
        ...env,
      },
    });
  }

  const twoBackups = [
    { type: "full", label: "20261115-050000F", start: seg(2), stop: seg(2) },
    {
      type: "diff",
      label: "20261115-050000F_20261116-050000D",
      start: seg(9),
      stop: seg(9),
    },
  ] as const;

  it("backs up, checks, reads the archive, and pings success with a summary", () => {
    const result = backup(["diff"], {
      backups: [...twoBackups],
      present: segments(1, 10),
    });

    expect(result.status).toBe(0);
    const commands = box
      .calls("pgbackrest")
      .map((call) => call.replace(/^pgbackrest /, ""));
    expect(commands).toEqual([
      "--stanza=trajetto --repo=1 --type=diff backup",
      "--stanza=trajetto check",
      "--stanza=trajetto --repo=1 info",
      "--repo=1 repo-ls archive/trajetto",
      "--repo=1 repo-ls archive/trajetto/16-1/0000000100000000",
    ]);
    expect(result.stdout).toContain(
      '{"result":"ok","type":"diff","repo":1,"label":"20261115-050000F_20261116-050000D","previous":"20261115-050000F"',
    );
    expect(result.stdout).toContain('"wal_segments":8');
    const pings = box.calls("wget");
    expect(pings[0]).toContain(`${PING}/start`);
    expect(pings[1]).toMatch(/--post-data \{"result":"ok"/);
    expect(pings[1]).toMatch(new RegExp(`${PING}$`));
  });

  it("pings /fail with archive-gap when a segment since the previous backup is missing, and asks for a full", () => {
    const result = backup(["diff"], {
      backups: [...twoBackups],
      present: segments(1, 10, [5, 6]),
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("FALHOU (archive-gap)");
    expect(result.stderr).toContain(`faltam 2 segmento(s) de WAL`);
    expect(result.stderr).toContain(seg(5));
    expect(result.stderr).toContain("trajetto-backup full");
    const fail = last(box.calls("wget")) ?? "";
    expect(fail).toContain(`${PING}/fail`);
    expect(fail).toContain('"reason":"archive-gap"');
  });

  it("lets a full report the hole and succeed: it is the remedy, and its check must not stay red for a week", () => {
    const result = backup(["full"], {
      backups: [
        twoBackups[0],
        {
          type: "full",
          label: "20261121-050000F",
          start: seg(12),
          stop: seg(12),
        },
      ],
      present: segments(1, 13, [7]),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("AVISO: archive-gap");
    expect(result.stdout).toContain('"archive_gap":"faltam 1 segmento(s)');
    expect(last(box.calls("wget"))).toMatch(new RegExp(`${PING}-full$`));
  });

  it("walks the archive across a 4 GiB boundary of segment names", () => {
    // ...00000000FF is followed by ...0000000100000000.
    const result = backup(["diff"], {
      backups: [
        {
          type: "full",
          label: "20261115-050000F",
          start: seg(250),
          stop: seg(250),
        },
        {
          type: "diff",
          label: "20261115-050000F_20261116-050000D",
          start: seg(262),
          stop: seg(262),
        },
      ],
      present: segments(240, 270),
    });

    expect(result.status).toBe(0);
    expect(
      box.calls("pgbackrest").filter((call) => call.includes("16-1/")),
    ).toEqual([
      "pgbackrest --repo=1 repo-ls archive/trajetto/16-1/0000000100000000",
      "pgbackrest --repo=1 repo-ls archive/trajetto/16-1/0000000100000001",
    ]);
    expect(result.stdout).toContain('"wal_segments":13');
  });

  it("checks only the new backup's own range after a timeline change", () => {
    const result = backup(["diff"], {
      backups: [
        twoBackups[0],
        {
          type: "diff",
          label: "20261115-050000F_20261116-050000D",
          start: "000000020000000000000009",
          stop: "000000020000000000000009",
        },
      ],
      present: "000000020000000000000009-" + "ab".repeat(20) + ".zst\n",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("timeline mudou");
  });

  it("stops at a failed backup: no check, a /fail with the reason", () => {
    const result = backup(["diff"], {
      backups: [...twoBackups],
      present: segments(1, 10),
      env: { STUB_BACKUP_EXIT: "1" },
    });

    expect(result.status).toBe(3);
    expect(box.calls("pgbackrest").some((call) => call.includes("check"))).toBe(
      false,
    );
    expect(last(box.calls("wget"))).toContain('"reason":"backup-failed"');
  });

  it("fails when the archive does not take a segment right after the backup", () => {
    const result = backup(["diff"], {
      backups: [...twoBackups],
      present: segments(1, 10),
      env: { STUB_CHECK_EXIT: "1" },
    });

    expect(result.status).toBe(4);
    expect(last(box.calls("wget"))).toContain('"reason":"check-failed"');
  });

  it("never prints or sends a key, the passphrase or the ping URL, even when pgBackRest quotes one", () => {
    const result = backup(["diff"], {
      backups: [...twoBackups],
      present: segments(1, 10),
      env: {
        STUB_INFO_ERROR: `ERROR: [039]: bad passphrase '${SECRET_CIPHER}' for key ${SECRET_WRITE_KEY}`,
      },
    });

    expect(result.status).toBe(5);
    expect(result.stderr).toContain("<redacted>");
    const sent = everything(result).split(PING).join("");
    for (const secret of SECRETS) {
      if (secret !== PING) expect(sent).not.toContain(secret);
    }
    // The URL is only ever the ping's destination, never in a body.
    for (const call of box.calls("wget")) {
      const body = /--post-data (.*) https:/.exec(call)?.[1] ?? "";
      expect(body).not.toContain(PING);
    }
  });

  it("refuses anything but full or diff, before touching pgBackRest", () => {
    for (const args of [[], ["incr"], ["diff", "--repo=3"], ["full", "x"]]) {
      expect(
        backup(args, { backups: [...twoBackups], present: "" }).status,
      ).toBe(1);
    }
    expect(box.calls("pgbackrest")).toEqual([]);
  });

  it("runs without a ping URL, and a ping that fails never fails the backup", () => {
    expect(
      backup(["diff"], {
        backups: [...twoBackups],
        present: segments(1, 10),
        env: { PITR_BACKUP_DIFF_PING_URL: "" },
      }).status,
    ).toBe(0);
    expect(box.calls("wget")).toEqual([]);

    const failing = backup(["diff"], {
      backups: [...twoBackups],
      present: segments(1, 10),
      env: { STUB_WGET_EXIT: "1" },
    });

    expect(failing.status).toBe(0);
    expect(failing.stderr).toContain("o healthchecks não respondeu");
  });

  it("backs up the second repository on request", () => {
    backup(["full", "--repo=2"], {
      backups: [twoBackups[0]],
      present: segments(1, 3),
    });

    expect(box.calls("pgbackrest")[0]).toBe(
      "pgbackrest --stanza=trajetto --repo=2 --type=full backup",
    );
  });
});

describe.skipIf(!bash)("trajetto-restore-drill on the host", () => {
  const dbEnv = [
    "PATH=/usr/local/bin:/usr/bin",
    "POSTGRES_USER=trajetto",
    "POSTGRES_DB=trajetto",
    "POSTGRES_PASSWORD=db-password-never-copied",
    "POSTGRES_MAX_CONNECTIONS=200",
    "PITR_ARCHIVE=on",
    `PGBACKREST_REPO1_S3_ENDPOINT=${repoEnv.PGBACKREST_REPO1_S3_ENDPOINT}`,
    `PGBACKREST_REPO1_S3_BUCKET=${repoEnv.PGBACKREST_REPO1_S3_BUCKET}`,
    `PGBACKREST_REPO1_S3_KEY=${SECRET_WRITE_KEY}`,
    `PGBACKREST_REPO1_S3_KEY_SECRET=${SECRET_WRITE_SECRET}`,
    `PGBACKREST_REPO1_CIPHER_PASS=${SECRET_CIPHER}`,
    `PITR_DRILL_REPO1_S3_KEY=${SECRET_READ_KEY}`,
    `PITR_DRILL_REPO1_S3_KEY_SECRET=${SECRET_READ_SECRET}`,
    `PITR_DRILL_PING_URL=${PING}`,
  ];

  const IMAGE =
    "ghcr.io/trajetto-organization/trajetto-postgres@sha256:" + "c".repeat(64);

  function host(
    args: string[],
    {
      env = dbEnv,
      ioWeight = true,
      startExit = 0,
    }: { env?: string[]; ioWeight?: boolean; startExit?: number } = {},
  ) {
    box.file("db.env", env.join("\n") + "\n");
    box.stub(
      "docker",
      `
case "$1" in
  inspect)
    case "$*" in
      *Config.Image*) echo "${IMAGE}" ;;
      *Config.Env*) cat "${box.root}/db.env" ;;
    esac ;;
  run) exit ${ioWeight ? 0 : 125} ;;
  create)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--env-file" ]; then cp "$2" "${box.root}/created.env"; echo "$2" > "${box.root}/envfile-path"; fi
      shift
    done
    echo cid123 ;;
  start) exit ${startExit} ;;
esac
exit 0`,
    );

    const result = run(
      "bash",
      repoFile("infra/postgres/bin/trajetto-restore-drill"),
      args,
      { bin: box.bin },
    );
    const created = existsSync(`${box.root}/created.env`)
      ? readFileSync(`${box.root}/created.env`, "utf8")
      : "";
    const envfile = existsSync(`${box.root}/envfile-path`)
      ? readFileSync(`${box.root}/envfile-path`, "utf8").trim()
      : "";

    return { ...result, created, envfile };
  }

  it("hands the drill the Database's max_wal_size, which bounds the WAL its recovery keeps", () => {
    const result = host(["--from", "db-container"], {
      env: [...dbEnv, "POSTGRES_MAX_WAL_SIZE=1GB"],
    });

    expect(result.status).toBe(0);
    expect(result.created).toContain("POSTGRES_MAX_WAL_SIZE=1GB\n");
  });

  it("creates the drill from the Database's own image, capped, with the read-only key in place of the write key", () => {
    const result = host(["--from", "db-container"]);

    expect(result.status).toBe(0);
    const create =
      box.calls("docker").find((call) => / create /.test(` ${call} `)) ?? "";
    expect(create).toMatch(
      /^docker create --rm --name trajetto-restore-drill-\d{14} --cpus 1 --memory 1g --memory-swap 1g --blkio-weight 100 --env-file /,
    );
    expect(create).toMatch(
      new RegExp(
        `${IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} trajetto-restore-drill --inside --repo=1$`,
      ),
    );
    expect(result.created).toContain(
      `PGBACKREST_REPO1_S3_KEY=${SECRET_READ_KEY}\n`,
    );
    expect(result.created).toContain(
      `PGBACKREST_REPO1_S3_KEY_SECRET=${SECRET_READ_SECRET}\n`,
    );
    expect(result.created).not.toContain(SECRET_WRITE_KEY);
    expect(result.created).not.toContain(SECRET_WRITE_SECRET);
    expect(result.created).toContain(
      `PGBACKREST_REPO1_CIPHER_PASS=${SECRET_CIPHER}\n`,
    );
    expect(result.created).toContain(
      "PGBACKREST_REPO1_S3_BUCKET=trajetto-pitr-test\n",
    );
    expect(result.created).toContain("POSTGRES_MEMORY_LIMIT_MB=1024\n");
    expect(result.created).toContain("POSTGRES_MAX_CONNECTIONS=200\n");
    // Never archiving, never the database's password.
    expect(result.created).not.toContain("PITR_ARCHIVE");
    expect(result.created).not.toContain("POSTGRES_PASSWORD");
    // Docker read it at create; no copy of a key stays on the disk.
    expect(result.envfile).not.toBe("");
    expect(existsSync(result.envfile)).toBe(false);
    expect(last(box.calls("docker"))).toBe("docker start --attach cid123");
  });

  it("drops only the I/O weight where the kernel refuses it, never the CPU and memory caps", () => {
    const result = host(["--from", "db-container"], { ioWeight: false });

    expect(result.status).toBe(0);
    const create =
      box.calls("docker").find((call) => / create /.test(` ${call} `)) ?? "";
    expect(create).not.toContain("--blkio-weight");
    expect(create).toContain("--cpus 1 --memory 1g --memory-swap 1g");
    expect(result.stderr).toContain("não aceita peso de I/O");
  });

  it("returns the drill's own exit status", () => {
    expect(host(["--from", "db-container"], { startExit: 4 }).status).toBe(4);
  });

  it("refuses to run without the read-only key, and never falls back to the write key", () => {
    const result = host(["--from", "db-container"], {
      env: dbEnv.filter((line) => !line.startsWith("PITR_DRILL_REPO1_S3_KEY=")),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PITR_DRILL_REPO1_S3_KEY");
    expect(
      box.calls("docker").some((call) => call.startsWith("docker create")),
    ).toBe(false);
    expect(last(box.calls("wget"))).toContain('"reason":"drill-config"');
    for (const secret of SECRETS) {
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    }
  });

  it("restores from the second repository with its own read-only key", () => {
    const result = host(["--from", "db-container", "--repo=2"], {
      env: [
        ...dbEnv,
        "PGBACKREST_REPO2_TYPE=s3",
        "PGBACKREST_REPO2_S3_ENDPOINT=s3.example.com",
        "PGBACKREST_REPO2_S3_BUCKET=trajetto-pitr-second",
        "PGBACKREST_REPO2_S3_KEY=repo2-write-never-copied",
        "PGBACKREST_REPO2_S3_KEY_SECRET=repo2-write-secret-never-copied",
        "PGBACKREST_REPO2_CIPHER_TYPE=aes-256-cbc",
        "PGBACKREST_REPO2_CIPHER_PASS=repo2-cipher",
        "PITR_DRILL_REPO2_S3_KEY=repo2-read",
        "PITR_DRILL_REPO2_S3_KEY_SECRET=repo2-read-secret",
      ],
    });

    expect(result.status).toBe(0);
    expect(result.created).toContain("PGBACKREST_REPO2_S3_KEY=repo2-read\n");
    expect(result.created).not.toContain("repo2-write");
    expect(
      box.calls("docker").find((call) => call.startsWith("docker create")),
    ).toMatch(/trajetto-restore-drill --inside --repo=2$/);
  });

  it("restores into a named volume on request", () => {
    host(["--from", "db-container", "--volume=prod-db-2-drill"]);

    expect(
      box.calls("docker").find((call) => call.startsWith("docker create")),
    ).toContain(
      "--mount type=volume,src=prod-db-2-drill,dst=/var/lib/postgresql/data",
    );
  });

  it("joins the repository's network when asked (the image's S3 proof); R2 needs none", () => {
    host(["--from", "db-container", "--network=proof-net"]);

    expect(
      box.calls("docker").find((call) => call.startsWith("docker create")),
    ).toContain("--network proof-net");

    host(["--from", "db-container"]);
    expect(
      box
        .calls("docker")
        .filter((call) => call.startsWith("docker create"))
        .pop(),
    ).not.toContain("--network");
  });

  it("refuses a target without a time zone, or a network or volume that is not a name", () => {
    for (const args of [
      ["--target=2026-12-01 05:00:00"],
      ["--network=net;rm"],
      ["--volume=../x"],
    ]) {
      expect(host(["--from", "db-container", ...args]).status, args[0]).toBe(1);
    }
    expect(box.calls("docker")).toEqual([]);
  });
});

describe("the image's S3 proof (infra/postgres/test/s3-proof.sh)", () => {
  const proof = readFileSync(
    repoFile("infra/postgres/test/s3-proof.sh"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("talks to S3 as to R2: the region and the path style come from the image's own configuration", () => {
    // Overriding them here would prove a configuration production never runs.
    expect(proof).not.toMatch(
      /PGBACKREST_REPO1_S3_REGION|PGBACKREST_REPO1_S3_URI_STYLE/,
    );
    expect(proof).toContain("--certs-dir /certs");
  });

  it("runs the drill as the Schedule Job does, with a key that can only read and list", () => {
    expect(proof).toContain(
      'docker exec "$DB" cat /usr/local/bin/trajetto-restore-drill \\\n  | bash -s -- --from "$DB"',
    );
    expect(proof).toContain('echo "PITR_DRILL_REPO1_S3_KEY=${READ_KEY}"');
    const policy = /"Action": \[([^\]]+)\]/.exec(proof)?.[1] ?? "";
    expect(policy).toContain("s3:GetObject");
    expect(policy).toContain("s3:ListBucket");
    expect(policy).not.toMatch(/Put|Delete|\*/);
    expect(proof).toContain(
      '[[ "$summary" == *\'"counts":{"business":2}\'* ]]',
    );
  });

  it("leaves nothing behind: every container, the network and the volume under its prefix", () => {
    expect(proof).toContain('docker ps -aq --filter "name=^${PREFIX}-"');
    // MinIO declares a VOLUME: without -v every run left one behind.
    expect(proof).toContain("xargs -r docker rm -f -v");
    expect(proof).toContain('docker volume rm "$VOLUME"');
    expect(proof).toContain('docker network rm "$NET"');
    expect(proof).toMatch(/trap cleanup EXIT/);
  });
});

describe.skipIf(!bash)("trajetto-restore-drill in its container", () => {
  const NOW = Math.floor(Date.now() / 1000);

  function inside(
    args: string[] = ["--inside"],
    {
      env = {},
      size = "29.3MB",
      freeKb = 50 * 1024 * 1024,
      availableKb = 8 * 1024 * 1024,
      psql = {},
      dirty = false,
      // The archive's newest segment: by default ten after the backup's
      // start, a short replay (11 segments of 16 MiB).
      archiveMax = seg(12),
      // What the started server does after recording its arguments.
      server = "exec tail -f /dev/null",
    }: {
      env?: Record<string, string>;
      size?: string;
      freeKb?: number;
      availableKb?: number;
      psql?: Record<string, string>;
      dirty?: boolean;
      archiveMax?: string | null;
      server?: string;
    } = {},
  ) {
    const data = `${box.root}/data`;
    if (dirty) box.file("data/PG_VERSION", "16\n");
    box.stub(
      "df",
      `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 1 1 ${freeKb} 1%% /\\n'`,
    );
    box.stub("gosu", 'shift; exec "$@"');
    box.stub("chown", "exit 0");
    box.stub(
      "trajetto-entrypoint.sh",
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > "${box.root}/server-argv"\n${server}`,
    );
    const answers = {
      recovery: "f",
      migrations: "120 0 20261115140000_pgss_snapshot",
      counts: '"business":3,"user":10',
      marker: String(NOW - 90),
      target: String(NOW - 3600),
      ...psql,
    };
    box.stub(
      "psql",
      `
all="$*"
[ -t 0 ] || all="$all $(cat)"
case "$all" in
  *pg_is_in_recovery*) echo "${answers.recovery}" ;;
  *_prisma_migrations*) echo "${answers.migrations}" ;;
  *query_to_xml\\(format*) echo '${answers.counts}' ;;
  *ops_sample*) echo "${answers.marker}" ;;
  *"::timestamptz"*) echo "${answers.target}" ;;
  *"SELECT 1"*) echo 1 ;;
esac
exit 0`,
    );

    const result = run(
      "bash",
      repoFile("infra/postgres/bin/trajetto-restore-drill"),
      args,
      {
        bin: box.bin,
        env: {
          PGDATA: data,
          POSTGRES_USER: "trajetto",
          POSTGRES_DB: "trajetto",
          PGBACKREST_REPO1_S3_ENDPOINT: repoEnv.PGBACKREST_REPO1_S3_ENDPOINT,
          PGBACKREST_REPO1_S3_BUCKET: repoEnv.PGBACKREST_REPO1_S3_BUCKET,
          PGBACKREST_REPO1_S3_KEY: SECRET_READ_KEY,
          PGBACKREST_REPO1_S3_KEY_SECRET: SECRET_READ_SECRET,
          PGBACKREST_REPO1_CIPHER_PASS: SECRET_CIPHER,
          PITR_DRILL_PING_URL: PING,
          PITR_DRILL_MAX_DISK_FRACTION: "",
          STUB_INFO: box.file(
            "info.txt",
            info(
              [
                {
                  type: "full",
                  label: "20261115-050000F",
                  start: seg(2),
                  stop: seg(2),
                  size,
                },
              ],
              archiveMax,
            ),
          ),
          TRAJETTO_MEMINFO: box.file(
            "meminfo",
            `MemTotal: 12000000 kB\nMemAvailable: ${availableKb} kB\n`,
          ),
          TRAJETTO_CGROUP_ROOT: `${box.root}/cgroup`,
          TRAJETTO_DRILL_SOCKET: `${box.root}/socket`,
          ...env,
        },
      },
    );
    const serverArgv = existsSync(`${box.root}/server-argv`)
      ? readFileSync(`${box.root}/server-argv`, "utf8").split("\n")
      : [];
    // What the drill left in PGDATA.
    const left = existsSync(data) ? readdirSync(data) : [];

    return { ...result, serverArgv, left };
  }

  const restores = () =>
    box.calls("pgbackrest").filter((call) => call.endsWith(" restore"));

  it("restores with archiving off, starts capped by the image's own wrapper, reads the copy and pings a JSON summary", () => {
    box.file("cgroup/memory.max", `${1024 * 1048576}\n`);

    const result = inside();

    expect(result.status).toBe(0);
    expect(restores()).toEqual([
      `pgbackrest --stanza=trajetto --repo=1 --pg1-path=${box.root}/data --archive-mode=off restore`,
    ]);
    const argv = result.serverArgv.join(" ");
    expect(argv).toContain(
      "postgres -c archive_mode=off -c listen_addresses= -c shared_buffers=128MB",
    );
    expect(argv).toContain(`-c hba_file=${box.root}/socket.hba`);
    const summary = JSON.parse(last(result.stdout.trim().split("\n")) ?? "");
    expect(summary).toMatchObject({
      result: "ok",
      repo: 1,
      backup: "20261115-050000F",
      target: "latest",
      migrations: { applied: 120, last: "20261115140000_pgss_snapshot" },
      counts: { business: 3, user: 10 },
    });
    // The loss: the drill's start minus the newest 'cluster' row.
    expect(summary.loss_seconds).toBeGreaterThanOrEqual(90);
    expect(summary.loss_seconds).toBeLessThan(150);
    expect(summary.rto_seconds).toBeGreaterThanOrEqual(0);
    const pings = box.calls("wget");
    expect(pings[0]).toContain(`${PING}/start`);
    expect(last(pings)).toMatch(/--post-data \{"result":"ok"/);
  });

  it("aborts before writing anything when the backup would take over half the free disk, and pings drill-disk", () => {
    const result = inside(["--inside"], {
      size: "29.3GB",
      freeKb: 40 * 1024 * 1024,
    });

    expect(result.status).toBe(3);
    expect(restores()).toEqual([]);
    expect(result.stderr).toContain("FALHOU (drill-disk)");
    expect(last(box.calls("wget"))).toContain(`${PING}/fail`);
    expect(last(box.calls("wget"))).toContain('"reason":"drill-disk"');
  });

  it("takes the fraction from the environment, a Brazilian comma included", () => {
    const result = inside(["--inside"], {
      size: "29.3GB",
      freeKb: 40 * 1024 * 1024,
      env: { PITR_DRILL_MAX_DISK_FRACTION: "0,8" },
    });

    expect(result.status).toBe(0);
  });

  describe("counts the WAL the recovery keeps in pg_wal, not only the database", () => {
    // Staging's case: a 300 MB database, 10 GiB free, so 5 GiB allowed.
    const small = { size: "300.0MB", freeKb: 10 * 1024 * 1024 };
    // A day-old backup: archive_timeout=60s makes every minute a whole
    // 16 MiB segment, some 22.5 GiB of WAL to replay.
    const dayOfWal = seg(2 + 1440);

    it.each([
      ["the Database's 8GB", { POSTGRES_MAX_WAL_SIZE: "8GB" }],
      ["no POSTGRES_MAX_WAL_SIZE (the wrapper's 8GB)", {}],
      [
        "an unreadable one (the wrapper's 8GB)",
        { POSTGRES_MAX_WAL_SIZE: "8G" },
      ],
    ])(
      "aborts with drill-disk when the database fits but its WAL does not: %s",
      (_, env) => {
        const result = inside(["--inside"], {
          ...small,
          archiveMax: dayOfWal,
          env,
        });

        expect(result.status).toBe(3);
        expect(restores()).toEqual([]);
        expect(result.stderr).toContain("FALHOU (drill-disk)");
        // 1 GiB of the drill's own plus 8 GiB of the primary's checkpoints.
        expect(result.stderr).toContain("até 9216 MiB de WAL");
        expect(last(box.calls("wget"))).toContain('"reason":"drill-disk"');
      },
    );

    it("lets the same drill run when the Database's checkpoints are 1GB apart (staging)", () => {
      const result = inside(["--inside"], {
        ...small,
        archiveMax: dayOfWal,
        env: { POSTGRES_MAX_WAL_SIZE: "1GB" },
      });

      expect(result.status).toBe(0);
    });

    it("counts only the WAL there is to replay when that is less", () => {
      const result = inside(["--inside"], {
        ...small,
        env: { POSTGRES_MAX_WAL_SIZE: "8GB" },
      });

      expect(result.status).toBe(0);
    });

    it("assumes the bound when the archive's end is unreadable", () => {
      expect(
        inside(["--inside"], {
          ...small,
          archiveMax: null,
          env: { POSTGRES_MAX_WAL_SIZE: "8GB" },
        }).status,
      ).toBe(3);
    });

    it("starts the copy with its own max_wal_size, whatever the Database runs", () => {
      const result = inside(["--inside"], {
        env: { POSTGRES_MAX_WAL_SIZE: "8GB" },
      });

      expect(result.status).toBe(0);
      expect(result.serverArgv.join(" ")).toContain(
        "-c shared_buffers=128MB -c max_wal_size=1GB",
      );
    });
  });

  it("aborts when the server has less RAM free than the drill's cap", () => {
    const result = inside(["--inside"], { availableKb: 512 * 1024 });

    expect(result.status).toBe(3);
    expect(restores()).toEqual([]);
    expect(last(box.calls("wget"))).toContain('"reason":"drill-ram"');
  });

  it("never restores over something", () => {
    const result = inside(["--inside"], { dirty: true });

    expect(result.status).toBe(1);
    expect(restores()).toEqual([]);
    // Not the drill's to wipe either.
    expect(result.left).toEqual(["PG_VERSION"]);
    expect(last(box.calls("wget"))).toContain('"reason":"drill-dirty"');
  });

  describe("wipes the copy it restored when it ends: production's personal data never outlives the drill, in a named volume either", () => {
    it.each([
      ["a drill that passes", {}, 0],
      [
        "a check that fails",
        { psql: { migrations: "120 1 20261115140000_pgss_snapshot" } },
        4,
      ],
      [
        "a restore that fails half-way",
        { env: { STUB_RESTORE_ERROR: "ERROR: [039]: broken" } },
        4,
      ],
    ])("%s", (_, options, status) => {
      const result = inside(["--inside"], options);

      expect(result.status).toBe(status);
      expect(restores()).toHaveLength(1);
      expect(result.left).toEqual([]);
      expect(result.stderr).toContain("cópia restaurada apagada");
    });

    it("when a docker stop (the image's STOPSIGNAL, INT) ends it mid-recovery", () => {
      box.stub(
        "sleep",
        `if [ ! -e "${box.root}/stopped" ]; then : > "${box.root}/stopped"; kill -INT "$PPID"; fi
exit 0`,
      );

      const result = inside(["--inside"], { psql: { recovery: "t" } });

      expect(result.status).toBe(130);
      expect(result.left).toEqual([]);
      expect(result.stdout).not.toContain('"result":"ok"');
    });

    it("when a TERM ends it, once, even if a second signal comes", () => {
      // The first two sleeps each send the drill a TERM: one while it
      // waits for the recovery, one while it waits for a server that
      // ignores TERM to stop.
      box.stub(
        "sleep",
        `n=$(cat "${box.root}/terms" 2> /dev/null || echo 0)
if [ "$n" -lt 2 ]; then echo $((n + 1)) > "${box.root}/terms"; kill -TERM "$PPID"; fi
exit 0`,
      );

      const result = inside(["--inside"], {
        psql: { recovery: "t" },
        server: "trap '' TERM; exec tail -f /dev/null",
      });

      expect(result.status).toBe(143);
      expect(result.left).toEqual([]);
      expect(result.stdout).not.toContain('"result":"ok"');
    });
  });

  it("restores to an instant with --target, and measures the loss against it", () => {
    const result = inside(["--inside", "--target=2026-12-01 05:00:00+00"]);

    expect(result.status).toBe(0);
    expect(restores()[0]).toContain(
      "--archive-mode=off --type=time --target=2026-12-01 05:00:00+00 --target-action=promote restore",
    );
    const summary = JSON.parse(last(result.stdout.trim().split("\n")) ?? "");
    expect(summary.target).toBe("2026-12-01 05:00:00+00");
    // target − marker = (NOW − 3600) − (NOW − 90)
    expect(summary.loss_seconds).toBe(-3510);
  });

  it("fails on a migration left half-way in the copy", () => {
    const result = inside(["--inside"], {
      psql: { migrations: "120 1 20261115140000_pgss_snapshot" },
    });

    expect(result.status).toBe(4);
    expect(last(box.calls("wget"))).toContain('"reason":"drill-migrations"');
  });

  it("says when the copy has no marker, instead of inventing a loss", () => {
    const result = inside(["--inside"], { psql: { marker: "" } });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"loss_seconds":null');
    expect(result.stderr).toContain("a perda não foi medida");
  });

  it("restores from the second repository on request", () => {
    inside(["--inside", "--repo=2"]);

    expect(restores()[0]).toMatch(/^pgbackrest --stanza=trajetto --repo=2 /);
  });

  it("never prints or sends a key, the passphrase or the ping URL", () => {
    const result = inside(["--inside"], {
      env: {
        STUB_RESTORE_ERROR: `ERROR: [028]: access denied for ${SECRET_READ_KEY} / ${SECRET_READ_SECRET} with '${SECRET_CIPHER}'`,
      },
    });

    expect(result.status).toBe(4);
    expect(result.stderr).toContain("<redacted>");
    const said = `${result.stdout}\n${result.stderr}`;
    for (const secret of SECRETS) expect(said).not.toContain(secret);
    for (const call of box.calls("wget")) {
      const body = /--post-data (.*) https:/.exec(call)?.[1] ?? "";
      for (const secret of SECRETS) expect(body).not.toContain(secret);
    }
  });
});

describe("the image", () => {
  const read = (path: string) =>
    readFileSync(repoFile(path), "utf8").replace(/\r\n/g, "\n");

  it("ships both scripts, executable, with the server they back up", () => {
    expect(read("infra/postgres/Dockerfile")).toContain(
      "COPY --link --chmod=0755 bin/trajetto-backup bin/trajetto-restore-drill /usr/local/bin/",
    );
  });

  it("runs both for real in its test stage, the archive-gap included", () => {
    const test = read("infra/postgres/test/run.sh");

    expect(test).toContain("trajetto-backup diff");
    expect(test).toContain("trajetto-restore-drill --inside");
    expect(test).toContain(
      '^/backup-diff/fail {"result":"fail","reason":"archive-gap"',
    );
    // ...and the drill, for real, leaves nothing of the copy behind.
    expect(test).toContain(
      '[ -z "$(ls -A "${WORK}/drill" 2> /dev/null)" ] || fail',
    );
  });
});
