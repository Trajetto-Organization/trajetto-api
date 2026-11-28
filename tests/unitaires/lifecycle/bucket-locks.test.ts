import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The Bucket Lock rules of the backups and the proofs (plano-escala F1-26).
 *
 * Every copy was deletable from the one host: the PITR's write key lives in
 * the Database's Environment and an R2 token cannot write without being able
 * to delete. The lock is a rule on the bucket, applied by hand in the R2
 * panel and written down in infra/r2/bucket-locks.md; nothing applies it
 * but the owner. What can go wrong is a rule that fights the tool that
 * cleans the bucket: a lock longer than pgBackRest's retention makes every
 * `expire` fail, a prefix that covers backup.info (rewritten by every
 * backup) makes every backup fail, and a lock longer than the Dokploy
 * dump's Keep Latest makes its cleanup fail. So the document is read as
 * data here and checked against pgbackrest.conf, the dump in deploy.md and
 * the proof's storage key.
 */
const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const DOC = "infra/r2/bucket-locks.md";
const doc = read(DOC);
const conf = read("infra/postgres/pgbackrest.conf");
const dockerfile = read("infra/postgres/Dockerfile");

interface Rule {
  bucket: string;
  prefix: string;
  days: number;
  status: string;
}

const code = (cell: string) => /`([^`]*)`/.exec(cell)?.[1] ?? null;

/** The rows of the "As regras" table: bucket, prefix, lock and status. */
function rules(text: string): Rule[] {
  const section = text
    .split(/^## /m)
    .find((part) => part.startsWith("As regras"));

  if (!section) throw new Error(`${DOC}: seção "As regras" não encontrada`);

  // The section's first table only: the subsections have tables of their own.
  const lines = section.split("\n");
  const start = lines.findIndex((line) => line.startsWith("|"));
  const end = lines.findIndex(
    (line, index) => index > start && !line.startsWith("|"),
  );

  const rows = lines.slice(start, end).map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );

  const [header, , ...body] = rows;

  expect(header?.slice(0, 3)).toEqual(["Bucket", "Prefixo", "Lock (dias)"]);

  return body.map(([bucket, prefix, days, , status]) => ({
    // A bucket that is not one name (the uploads bucket differs per
    // environment) is kept as written.
    bucket: code(bucket) ?? bucket,
    // "(o bucket inteiro)": an empty prefix, which R2 reads as every object.
    prefix: code(prefix) ?? "",
    days: Number(days),
    status,
  }));
}

/** `name=value` of pgbackrest.conf's [global] section. */
function globalOption(name: string): string {
  const global = conf.split(/^\[/m).find((part) => part.startsWith("global]"));
  const match = new RegExp(`^${name}=(.+)$`, "m").exec(global ?? "");

  if (!match) throw new Error(`pgbackrest.conf: ${name} ausente em [global]`);

  return match[1].trim();
}

const RULES = rules(doc);
const PITR_BUCKETS = ["trajetto-pitr-staging", "trajetto-pitr-prod"];

/** The stanza: the one section of pgbackrest.conf besides the global ones. */
const STANZA = [...conf.matchAll(/^\[([a-z0-9_-]+)\]$/gm)]
  .map((match) => match[1])
  .filter((name) => name !== "global")[0];

/** The PostgreSQL major the image runs: the archive id starts with it. */
const PG_MAJOR = /^FROM postgres:(\d+)-alpine@sha256:/m.exec(dockerfile)?.[1];

const covers = (prefix: string, key: string) => key.startsWith(prefix);

describe("the document's rules", () => {
  it("are read: one per bucket and prefix, each with a whole number of days", () => {
    expect(RULES.length).toBeGreaterThanOrEqual(7);

    for (const rule of RULES) {
      expect(Number.isInteger(rule.days) && rule.days > 0, rule.bucket).toBe(
        true,
      );
    }

    const keys = RULES.map((rule) => `${rule.bucket} ${rule.prefix}`);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the PITR buckets", () => {
  const retentionDays = Number(globalOption("repo1-retention-full"));

  it("keep pgBackRest's retention by time, at the bucket's root, for one stanza", () => {
    // A count-based retention would turn the 30 into thirty fulls, and the
    // comparison below into nonsense.
    expect(globalOption("repo1-retention-full-type")).toBe("time");
    expect(retentionDays).toBeGreaterThan(0);
    // The prefixes below are written from the bucket's root.
    expect(globalOption("repo1-path")).toBe("/");
    expect(STANZA).toBe("trajetto");
    expect(PG_MAJOR).toBe("16");
  });

  it("lock for less than pgBackRest keeps, so expire only deletes what the lock let go", () => {
    for (const bucket of PITR_BUCKETS) {
      const own = RULES.filter((rule) => rule.bucket === bucket);

      expect(own.length, bucket).toBeGreaterThan(0);

      for (const rule of own) {
        expect(rule.days, `${bucket} ${rule.prefix}`).toBeLessThan(
          retentionDays,
        );
      }
    }
  });

  it("lock every WAL segment and history file of the image's major", () => {
    const wal = `archive/${STANZA}/${PG_MAJOR}-1/0000000100000000/000000010000000000000001-${"a".repeat(40)}.zst`;
    const history = `archive/${STANZA}/${PG_MAJOR}-1/00000002.history`;

    for (const bucket of PITR_BUCKETS) {
      const prefixes = RULES.filter((rule) => rule.bucket === bucket).map(
        (rule) => rule.prefix,
      );

      expect(
        prefixes.some((prefix) => covers(prefix, wal)),
        bucket,
      ).toBe(true);
      expect(
        prefixes.some((prefix) => covers(prefix, history)),
        bucket,
      ).toBe(true);
    }
  });

  it("never cover the files pgBackRest rewrites", () => {
    // Rewritten by every backup and every expire (backup.info), or by a
    // stanza-create or stanza-upgrade (archive.info): under a lock, the
    // second write is refused and the command fails.
    const rewritten = [
      `backup/${STANZA}/backup.info`,
      `backup/${STANZA}/backup.info.copy`,
      `backup/${STANZA}/backup.history/2026/20261116-050000F.manifest.gz`,
      `archive/${STANZA}/archive.info`,
      `archive/${STANZA}/archive.info.copy`,
    ];

    for (const rule of RULES.filter((r) => PITR_BUCKETS.includes(r.bucket))) {
      for (const key of rewritten) {
        expect(covers(rule.prefix, key), `${rule.prefix} cobre ${key}`).toBe(
          false,
        );
      }
    }
  });

  it("keep the rule on the backups' labels a proof, never a plain step", () => {
    // One backup writes its backup.manifest.copy several times (measured:
    // three with the default threshold): a lock on the labels refuses the
    // second write. The rule may only go in as the staging proof.
    const full = `backup/${STANZA}/20261116-050000F/backup.manifest.copy`;
    const diff = `backup/${STANZA}/20261116-050000F_20261117-050000D/pg_data/PG_VERSION.zst`;
    const onLabels = RULES.filter(
      (rule) =>
        PITR_BUCKETS.includes(rule.bucket) &&
        covers(rule.prefix, full) &&
        covers(rule.prefix, diff),
    );

    expect(onLabels.map((rule) => rule.bucket).sort()).toEqual(
      [...PITR_BUCKETS].sort(),
    );

    for (const rule of onLabels) {
      expect(rule.status, rule.bucket).toMatch(/prova/);
    }

    expect(doc).toMatch(/manifesto[\s\S]{0,200}reescrito/);
  });
});

describe("the Dokploy dump's bucket", () => {
  it("locks for less than the Keep Latest of a daily backup", () => {
    // deploy.md §18: a Keep Latest per prefix, on a once-a-day schedule,
    // so the count is a number of days. Dokploy deletes the copy past it.
    const deploy = read("docs/deploy.md");
    const backup = deploy
      .split(/^## /m)
      .find((part) => part.startsWith("18. Backup e restauração"));

    const kept = new Set(
      [...(backup ?? "").matchAll(/Keep Latest\W{0,16}(\d+)/g)].map((match) =>
        Number(match[1]),
      ),
    );
    const schedules = [
      ...(backup ?? "").matchAll(/`((?:[\d*/,-]+ ){4}[\d*/,-]+)`/g),
    ].map((match) => match[1]);

    expect(kept.size).toBe(1);
    expect(schedules.length).toBeGreaterThan(0);
    expect(
      schedules.every((cron) => /^\d{1,2} \d{1,2} \* \* \*$/.test(cron)),
    ).toBe(true);

    const rule = RULES.find((r) => r.bucket === "trajetto-backups-prod");

    expect(rule?.prefix).toBe("trajetto-production/");
    expect(rule?.days).toBeLessThan([...kept][0]);
  });
});

describe("the off-account copy's bucket", () => {
  it("locks for less than its own expiration", () => {
    const rule = RULES.find((r) => r.bucket === "trajetto-offsite");
    const row = doc
      .split("\n")
      .find((line) => line.startsWith("| `trajetto-offsite`"));
    const expiration = Number(/Expiration de (\d+) dias/.exec(row ?? "")?.[1]);

    expect(rule?.prefix).toBe("");
    expect(expiration).toBeGreaterThan(0);
    expect(rule?.days).toBeLessThan(expiration);
  });
});

describe("the proofs' prefix", () => {
  const rule = RULES.find((r) => r.prefix === "deliveryProofs/");

  it("is locked", () => {
    expect(rule?.days).toBeGreaterThan(0);
  });

  it("is never overwritten: the proof's key carries the hash of its bytes", () => {
    // A render never writes over the object a row points at, so a lock on
    // the prefix refuses nothing the API does.
    const storage = read("src/shared/delivery/proof-storage.ts");

    expect(storage).toMatch(
      /return `deliveryProofs\/\$\{deliveryId\}\/\$\{sha256\}\.pdf`;/,
    );
  });

  it("is never swept by the orphan collector", () => {
    const collector = read("src/shared/services/orphan-uploads.ts");

    // The other server-written namespace may join it (spreadsheetImports,
    // plano-escala F3-23a); deliveryProofs never leaves.
    expect(collector).toMatch(
      /type ClientUploadType = Exclude<\s*UploadType,\s*"deliveryProofs"(?:\s*\|\s*"[A-Za-z]+")*\s*>;/,
    );
    expect(collector).toMatch(
      /ORPHAN_GC_NAMESPACES: Record<ClientUploadType, NamespaceSpec>/,
    );
  });
});
