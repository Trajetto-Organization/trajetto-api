import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UPLOAD_TYPES } from "@/config/upload";
import { envShape } from "@/schemas/env-schema/defined-env";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * The lifecycle rules of the R2 buckets (plano-escala F5-28).
 *
 * The owner applies them by hand, with infra/r2/apply-lifecycle.sh, and
 * nothing in the pipeline looks at them again. What would go wrong there is
 * quiet and permanent: an Expiration that reaches the uploads bucket deletes
 * proofs the company must keep for five years; a new upload folder nobody
 * decided about stays in the expensive class forever, or a busy one (the
 * avatars) goes to the class that charges every read; the trail's archive
 * expiring at another age than the code assumes; a PUT that silently drops
 * a rule made in the panel. So the two JSON files are checked against the
 * code's upload folders and the env-schema's terms, and the script runs for
 * real under `sh`, with the aws CLI stubbed.
 */
const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");

interface Rule {
  ID: string;
  Status: string;
  Filter?: { Prefix?: string };
  Expiration?: { Days?: number; Date?: string };
  Transitions?: Array<{ Days?: number; StorageClass?: string }>;
  AbortIncompleteMultipartUpload?: { DaysAfterInitiation?: number };
}

const uploads = JSON.parse(read("infra/r2/lifecycle.json")) as {
  Rules: Rule[];
};
const archive = JSON.parse(read("infra/r2/archive-lifecycle.json")) as {
  Rules: Rule[];
};
const doc = read("infra/r2/lifecycle.md");

/** The folders read rarely after a while, by decision (F5-28). */
const INFREQUENT = [
  "deliveryProofs",
  "deliveryPhotos",
  "checklistPhotos",
  "odometerPhotos",
  "chatAttachments",
];

/** The folders that stay Standard, and why (in lifecycle.md). */
const STANDARD = ["avatars", "spreadsheetImports"];

/** A variable's default, as the env-schema gives it when it is unset. */
const defaultOf = (name: string) => envShape()[name].parse(undefined);

describe("infra/r2/lifecycle.json, the uploads bucket", () => {
  it("never expires anything", () => {
    for (const rule of uploads.Rules) {
      expect(rule.Expiration, rule.ID).toBeUndefined();
    }

    expect(JSON.stringify(uploads)).not.toMatch(/Expiration|NoncurrentVersion/);
  });

  it("moves the proofs, the photos and the chat to Infrequent Access at 60 days", () => {
    const moved = uploads.Rules.filter((rule) => rule.Transitions);

    expect(moved.map((rule) => rule.Filter?.Prefix).sort()).toEqual(
      INFREQUENT.map((folder) => `${folder}/`).sort(),
    );

    for (const rule of moved) {
      expect(rule.Status, rule.ID).toBe("Enabled");
      expect(rule.Transitions, rule.ID).toEqual([
        { Days: 60, StorageClass: "STANDARD_IA" },
      ]);
    }
  });

  it("decides every upload folder of the code: Infrequent Access or Standard", () => {
    expect([...INFREQUENT, ...STANDARD].sort()).toEqual(
      [...UPLOAD_TYPES].sort(),
    );

    for (const folder of STANDARD) {
      expect(JSON.stringify(uploads)).not.toContain(`"${folder}/`);
      expect(doc).toContain(`\`${folder}/\``);
    }
  });

  it("aborts an unfinished multipart upload after 7 days, bucket-wide", () => {
    expect(
      uploads.Rules.find((rule) => rule.AbortIncompleteMultipartUpload),
    ).toEqual({
      ID: "trajetto-abort-multipart",
      Status: "Enabled",
      Filter: { Prefix: "" },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
    });
  });
});

describe("infra/r2/archive-lifecycle.json, the archive bucket", () => {
  const rule = (id: string) => archive.Rules.find((each) => each.ID === id);

  it("expires the trail at TRAIL_ARCHIVE_RETENTION_DAYS", () => {
    expect(rule("trajetto-expire-trail")).toMatchObject({
      Status: "Enabled",
      Filter: { Prefix: "trail/" },
      Expiration: { Days: defaultOf("TRAIL_ARCHIVE_RETENTION_DAYS") },
    });
  });

  it("expires the history at no less than HISTORY_ARCHIVE_RETENTION_YEARS (decision D3)", () => {
    const history = rule("trajetto-expire-history");
    const years = defaultOf("HISTORY_ARCHIVE_RETENTION_YEARS") as number;

    expect(years).toBe(5);
    expect(history?.Filter).toEqual({ Prefix: "archive/" });
    // Every year of 365 days, and a leap day every four.
    expect(history?.Expiration?.Days).toBeGreaterThanOrEqual(
      years * 365 + Math.ceil(years / 4),
    );
  });

  it("writes nothing that moves storage class: the archive is born in STANDARD_IA", () => {
    expect(JSON.stringify(archive)).not.toContain("Transitions");
    expect(defaultOf("ARCHIVE_STORAGE_CLASS")).toBe("STANDARD_IA");
  });

  it("names every rule in the guide", () => {
    for (const each of [...uploads.Rules, ...archive.Rules]) {
      expect(doc).toContain(`\`${each.ID}\``);
    }
  });
});

const sh = hasShell("sh");

const SECRETS = {
  AWS_ACCESS_KEY_ID: "key-id-never-printed",
  AWS_SECRET_ACCESS_KEY: "secret+never/printed=",
};

describe.skipIf(!sh)("infra/r2/apply-lifecycle.sh", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
    // aws: the rules in place come from rules.txt (one ID per line; absent
    // = no configuration), a PUT is saved to put.json and becomes the rules
    // read next, unless STUB_READBACK says otherwise. Failures on demand
    // quote the key, as an SDK error might.
    box.stub(
      "aws",
      [
        `case "$*" in`,
        `  *get-bucket-lifecycle-configuration*)`,
        `    if [ -n "\${STUB_GET_FAIL:-}" ]; then echo "AccessDenied for \${AWS_ACCESS_KEY_ID}" >&2; exit 255; fi`,
        `    if [ ! -f "${box.root}/rules.txt" ]; then echo "An error occurred (NoSuchLifecycleConfiguration)" >&2; exit 254; fi`,
        `    if [ -n "\${STUB_READBACK:-}" ] && [ -f "${box.root}/put.json" ]; then printf '%s\\n' "$STUB_READBACK"; exit 0; fi`,
        `    tr '\\n' '\\t' < "${box.root}/rules.txt"; echo; exit 0 ;;`,
        `  *put-bucket-lifecycle-configuration*)`,
        `    if [ -n "\${STUB_PUT_FAIL:-}" ]; then echo "InvalidRequest \${AWS_SECRET_ACCESS_KEY}" >&2; exit 254; fi`,
        `    while [ "$#" -gt 0 ]; do if [ "$1" = "--lifecycle-configuration" ]; then printf '%s' "$2" > "${box.root}/put.json"; fi; shift; done`,
        `    node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.Rules.map(r=>r.ID).join("\\n"))' "${box.root}/put.json" > "${box.root}/rules.txt"`,
        `    exit 0 ;;`,
        `esac`,
        `exit 9`,
      ].join("\n"),
    );
  });

  afterEach(() => box.dispose());

  function apply(args: string[], env: Record<string, string> = {}) {
    return run("sh", repoFile("infra/r2/apply-lifecycle.sh"), args, {
      bin: box.bin,
      env: {
        R2_LIFECYCLE_ENDPOINT: "https://account.r2.example.com",
        STUB_GET_FAIL: "",
        STUB_PUT_FAIL: "",
        STUB_READBACK: "",
        ...SECRETS,
        ...env,
      },
    });
  }

  const sent = (): { Rules: Rule[] } =>
    JSON.parse(readFileSync(`${box.root}/put.json`, "utf8"));

  const expectNoSecret = (...texts: string[]) => {
    for (const text of texts) {
      for (const secret of Object.values(SECRETS)) {
        expect(text).not.toContain(secret);
      }
    }

    for (const call of box.calls("aws")) {
      for (const secret of Object.values(SECRETS)) {
        expect(call).not.toContain(secret);
      }
    }
  };

  it("puts the uploads rules on the uploads bucket, reads them back, and says ok", () => {
    const { status, stdout, stderr } = apply([
      "uploads",
      "trajetto-staging-storage",
    ]);

    expect(status, stderr).toBe(0);
    expect(sent()).toEqual(uploads);
    expect(
      box.calls("aws").filter((call) => call.includes("put-")),
    ).toHaveLength(1);
    expect(box.calls("aws")[0]).toContain(
      "--endpoint-url https://account.r2.example.com",
    );
    expect(box.calls("aws")[0]).toContain("--bucket trajetto-staging-storage");

    const summary = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");

    expect(summary).toMatchObject({
      result: "ok",
      mode: "uploads",
      bucket: "trajetto-staging-storage",
    });
    expect(summary.rules).toHaveLength(uploads.Rules.length);
    expectNoSecret(stdout, stderr);
  });

  it("leaves the history's Expiration out of the archive until it is asked for", () => {
    expect(apply(["archive", "trajetto-archive-staging"]).status).toBe(0);
    expect(sent().Rules.map((rule) => rule.ID)).toEqual([
      "trajetto-expire-trail",
      "trajetto-abort-multipart",
    ]);

    const asked = apply([
      "archive",
      "trajetto-archive-staging",
      "--with-history-expiration",
    ]);

    expect(asked.status, asked.stderr).toBe(0);
    expect(sent()).toEqual(archive);
  });

  it("never sends the archive's Expirations to a bucket that is not an archive", () => {
    for (const bucket of ["trajetto-prod-storage", "trajetto-backups-prod"]) {
      const { status, stderr } = apply(["archive", bucket]);

      expect(status).toBe(1);
      expect(stderr).toContain("bucket-mismatch");
    }

    for (const bucket of [
      "trajetto-archive-prod",
      "trajetto-backups-prod",
      "trajetto-pitr-prod",
      "trajetto-offsite",
    ]) {
      const { status, stderr } = apply(["uploads", bucket]);

      expect(status).toBe(1);
      expect(stderr).toContain("bucket-mismatch");
    }

    expect(box.calls("aws")).toEqual([]);
  });

  it("refuses to drop a rule it does not know, unless --replace", () => {
    box.file("rules.txt", "made-by-hand\ntrajetto-abort-multipart\n");

    const refused = apply(["uploads", "trajetto-prod-storage"]);

    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("unknown-rules");
    expect(refused.stderr).toContain("made-by-hand");
    expect(box.calls("aws").some((call) => call.includes("put-"))).toBe(false);

    const replaced = apply(["uploads", "trajetto-prod-storage", "--replace"]);

    expect(replaced.status, replaced.stderr).toBe(0);
    expect(sent()).toEqual(uploads);
  });

  it("sends nothing on a dry run", () => {
    const { status, stdout } = apply([
      "uploads",
      "trajetto-prod-storage",
      "--dry-run",
    ]);

    expect(status).toBe(0);
    expect(stdout).toContain("dry-run");
    expect(box.calls("aws").some((call) => call.includes("put-"))).toBe(false);
  });

  it("fails when the rules read back are not the ones sent", () => {
    const { status, stderr } = apply(["uploads", "trajetto-prod-storage"], {
      STUB_READBACK: "trajetto-abort-multipart",
    });

    expect(status).toBe(4);
    expect(stderr).toContain("readback-mismatch");
  });

  it("fails with 3 and a redacted error when the read or the PUT fails", () => {
    const read = apply(["uploads", "trajetto-prod-storage"], {
      STUB_GET_FAIL: "1",
    });

    expect(read.status).toBe(3);
    expect(read.stderr).toContain("read-failed");
    expect(read.stderr).toContain("<redacted>");

    const put = apply(["uploads", "trajetto-prod-storage"], {
      STUB_PUT_FAIL: "1",
    });

    expect(put.status).toBe(3);
    expect(put.stderr).toContain("put-failed");
    expect(put.stderr).toContain("<redacted>");
    expectNoSecret(read.stdout, read.stderr, put.stdout, put.stderr);
  });

  it("needs the endpoint and a known mode", () => {
    expect(
      apply(["uploads", "trajetto-prod-storage"], { R2_LIFECYCLE_ENDPOINT: "" })
        .status,
    ).toBe(1);
    expect(apply(["everything", "trajetto-prod-storage"]).status).toBe(1);
    expect(
      apply(["uploads", "trajetto-prod-storage", "--with-history-expiration"])
        .status,
    ).toBe(1);
  });
});
