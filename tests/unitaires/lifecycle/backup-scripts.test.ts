import { readdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The manual backup and the restore drill, executed with `docker` and `npx`
 * stubbed.
 *
 * Two ways the old scripts lied, both at the worst possible moment:
 *
 * - backup-postgres.sh streamed pg_dump straight into the final file. Under
 *   `set -e` a dump that died halfway exited BEFORE the size check, and the
 *   truncated file stayed in the directory looking like the newest backup —
 *   the one an operator picks during an incident.
 * - restore-postgres.sh "verified" the restored database with
 *   `prisma migrate deploy`, which APPLIES whatever is pending. A dump older
 *   than the code came out reporting "No pending migrations", hiding exactly
 *   the gap the drill exists to show.
 */
const bash = hasShell("bash");

const DOCKER = `
case "$1" in
  ps) echo "cafe1234" ;;
  rm|run) exit 0 ;;
  exec)
    case "$*" in
      *pg_dump*)
        head -c "\${STUB_DUMP_BYTES:-4096}" /dev/zero | tr '\\0' 'x'
        exit "\${STUB_DUMP_EXIT:-0}" ;;
      *"pg_restore --list"*)
        cat > /dev/null
        exit "\${STUB_TOC_EXIT:-0}" ;;
      *pg_isready*) exit 0 ;;
      *pg_restore*) cat > /dev/null; exit 0 ;;
      *psql*) echo "  _prisma_migrations: 1"; exit 0 ;;
    esac ;;
esac
exit 0`;

const NPX = `
case "$*" in
  *"migrate status"*)
    printf '%s\\n' "\${STUB_STATUS_OUTPUT:-Database schema is up to date!}"
    exit "\${STUB_STATUS_EXIT:-0}" ;;
  *) echo "No pending migrations to apply." ;;
esac
exit 0`;

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
  box.stub("docker", DOCKER);
  box.stub("npx", NPX);
});

afterEach(() => box.dispose());

const backupEnv = {
  POSTGRES_USERNAME: "trajetto",
  POSTGRES_DATABASE: "trajetto",
};

function backup(env: Record<string, string> = {}) {
  const out = `${box.root}/backups`;

  const result = run(
    "bash",
    repoFile("infra/scripts/backup-postgres.sh"),
    [out],
    {
      bin: box.bin,
      env: { ...backupEnv, ...env },
    },
  );

  let files: string[] = [];

  try {
    files = readdirSync(out);
  } catch {
    files = [];
  }

  return { ...result, out, files };
}

describe.skipIf(!bash)("the manual backup", () => {
  it("finds the Dokploy database's task by its service name, not the dev container's", () => {
    // A Dokploy PostgreSQL database is a Swarm service named after its
    // appName (random suffix), so `name=trajetto-database` finds nothing.
    const { status } = backup({ POSTGRES_SERVICE: "trajetto-api-db-x1y2" });

    expect(status).toBe(0);

    const ps = box.calls("docker").find((call) => call.startsWith("docker ps"));

    expect(ps).toContain(
      "label=com.docker.swarm.service.name=trajetto-api-db-x1y2",
    );
    expect(ps).not.toContain("name=trajetto-database");
  });

  it("leaves nothing behind when pg_dump dies halfway", () => {
    const { status, files } = backup({
      STUB_DUMP_BYTES: "100",
      STUB_DUMP_EXIT: "1",
    });

    expect(status).not.toBe(0);
    expect(files.filter((name) => name.includes(".dump"))).toEqual([]);
  });

  it("refuses a dump whose table of contents does not read back", () => {
    const { status, files } = backup({ STUB_TOC_EXIT: "1" });

    expect(status).not.toBe(0);
    expect(files.filter((name) => name.includes(".dump"))).toEqual([]);
  });

  it("still refuses a dump too small to be one", () => {
    const { status, files } = backup({ STUB_DUMP_BYTES: "10" });

    expect(status).not.toBe(0);
    expect(files.filter((name) => name.includes(".dump"))).toEqual([]);
  });

  it("writes the dump next to a checksum that verifies", () => {
    const { status, out, files } = backup();

    expect(status).toBe(0);

    const dump = files.find((name) => name.endsWith(".dump"));

    expect(dump, `arquivos: ${files.join(", ")}`).toBeTruthy();
    expect(files).toContain(`${dump}.sha256`);

    // Relative names inside the checksum file, so `sha256sum -c` works
    // wherever the pair is copied to.
    writeFileSync(`${box.root}/check.sh`, `sha256sum -c "${dump}.sha256"\n`);

    const verified = run("bash", `${box.root}/check.sh`, [], { cwd: out });

    expect(verified.status, verified.stdout + verified.stderr).toBe(0);
  });
});

describe.skipIf(!bash)(
  "the position trail in the manual backup (PG-11)",
  () => {
    /**
     * driver_position is the bulk of the database at scale (about 2,400 points
     * per driver per 10-hour day, ~450 B each with indexes, 90 days kept). A
     * logical dump that always carries it grows to hours, holding one snapshot
     * — and the xmin horizon of every hot table — the whole time. Leaving it
     * out, or dumping it on its own, is an operator's choice; the default stays
     * a full dump until the owner decides.
     */
    const dumpCall = () =>
      box.calls("docker").find((call) => call.includes("pg_dump")) ?? "";

    it("dumps everything by default", () => {
      expect(backup().status).toBe(0);
      expect(dumpCall()).not.toContain("driver_position");
    });

    it("can leave the trail's rows out, keeping its schema", () => {
      expect(backup({ BACKUP_EXCLUDE_TRAIL: "true" }).status).toBe(0);
      expect(dumpCall()).toContain(
        "--exclude-table-data-and-children=public.driver_position",
      );
    });

    it("can dump only the trail, into a file named for it", () => {
      const { status, files } = backup({ BACKUP_TRAIL_ONLY: "true" });

      expect(status).toBe(0);
      expect(dumpCall()).toContain(
        "--table-and-children=public.driver_position",
      );
      expect(files.find((name) => name.endsWith(".dump"))).toMatch(
        /^trajetto-trail-\d{8}T\d{6}Z\.dump$/,
      );
    });

    it("refuses both at once rather than guess", () => {
      const { status } = backup({
        BACKUP_EXCLUDE_TRAIL: "true",
        BACKUP_TRAIL_ONLY: "true",
      });

      expect(status).not.toBe(0);
      expect(dumpCall()).toBe("");
    });
  },
);

describe.skipIf(!bash)("the restore drill", () => {
  function restore(
    env: Record<string, string> = {},
    dumpName = "trajetto-x.dump",
  ) {
    const dump = box.file(`in/${dumpName}`, "x".repeat(4096));

    const result = run(
      "bash",
      repoFile("infra/scripts/restore-postgres.sh"),
      [dump, "drill-under-test", "55999"],
      { bin: box.bin, env },
    );

    return { ...result, dump };
  }

  it("rehearses on the image production runs", () => {
    // POSTGRES_IMAGE is the Dokploy database's exact image; a drill on
    // another minor proves less about the dump being restored.
    const pinned = "postgres:16.4-alpine@sha256:" + "a".repeat(64);
    const { status } = restore({ POSTGRES_IMAGE: pinned });

    expect(status).toBe(0);

    const started = box
      .calls("docker")
      .find((call) => call.startsWith("docker run"));

    expect(started).toContain(pinned);
  });

  it("verifies with `migrate status` and never applies a migration", () => {
    const { status, stdout, stderr } = restore();

    expect(status, stdout + stderr).toBe(0);

    const npx = box.calls("npx");

    expect(npx.some((call) => call.includes("prisma migrate status"))).toBe(
      true,
    );
    expect(npx.filter((call) => call.includes("migrate deploy"))).toEqual([]);
  });

  it("fails when the dump is older than the code, and says so", () => {
    const { status, stderr } = restore({
      STUB_STATUS_EXIT: "1",
      STUB_STATUS_OUTPUT:
        "Following migration have not yet been applied:\n20260924091600_worker_heartbeat",
    });

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/migrations pendentes/);
    expect(
      box.calls("npx").filter((call) => call.includes("migrate deploy")),
    ).toEqual([]);
  });

  it("refuses a dump whose checksum does not match, before starting anything", () => {
    const dump = box.file("in/trajetto-bad.dump", "x".repeat(4096));

    writeFileSync(`${dump}.sha256`, `${"0".repeat(64)}  trajetto-bad.dump\n`);

    const result = run(
      "bash",
      repoFile("infra/scripts/restore-postgres.sh"),
      [dump, "drill-under-test", "55999"],
      { bin: box.bin },
    );

    expect(result.status).not.toBe(0);
    expect(
      box.calls("docker").filter((call) => call.startsWith("docker run")),
    ).toEqual([]);
  });

  it("accepts a dump whose checksum matches", () => {
    const dump = box.file("in/trajetto-good.dump", "x".repeat(4096));

    writeFileSync(
      `${box.root}/sum.sh`,
      `cd "$(dirname "$1")" && sha256sum "$(basename "$1")" > "$1.sha256"\n`,
    );
    expect(run("bash", `${box.root}/sum.sh`, [dump]).status).toBe(0);
    expect(readFileSync(`${dump}.sha256`, "utf8")).toContain(
      "trajetto-good.dump",
    );

    const result = run(
      "bash",
      repoFile("infra/scripts/restore-postgres.sh"),
      [dump, "drill-under-test", "55999"],
      { bin: box.bin },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
