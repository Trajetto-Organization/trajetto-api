import { readFileSync } from "node:fs";
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
 * The weekly copy of the delivery proofs to another Cloudflare account
 * (plano-escala F1-23).
 *
 * infra/r2/offsite-copy.sh runs in the trajetto-offsite Application, from a
 * Schedule Job nobody watches. What would go wrong there is quiet: a `sync`
 * that turns a wiped source into a wiped copy, or carries a deletion the
 * copy exists to survive; a rewrite the Bucket Lock refuses every week; a
 * key printed into the Schedule Job's log or a healthchecks ping; a copy
 * "off the account" that points back at the same account. So the script
 * runs here for real, under `sh` (the image's shell is busybox), with rclone
 * and wget stubbed, and its document is checked against it.
 */
const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const SCRIPT = "infra/r2/offsite-copy.sh";
const script = read(SCRIPT);
const doc = read("infra/r2/offsite-copy.md");
const locks = read("infra/r2/bucket-locks.md");
const variables = read("docs/variaveis-de-ambiente.md");

const ENV = {
  OFFSITE_SOURCE_ENDPOINT: "https://source-account.r2.example.com",
  OFFSITE_SOURCE_BUCKET: "trajetto-uploads",
  OFFSITE_SOURCE_KEY: "src-key-never-printed",
  OFFSITE_SOURCE_KEY_SECRET: "src+secret/never=printed",
  OFFSITE_DEST_ENDPOINT: "https://dest-account.r2.example.com",
  OFFSITE_DEST_BUCKET: "trajetto-offsite",
  OFFSITE_DEST_KEY: "dst-key-never-printed",
  OFFSITE_DEST_KEY_SECRET: "dst.secret*never[printed]",
  OFFSITE_PING_URL: "https://hc-ping.example.com/ping-never-printed",
  OFFSITE_PREFIXES: "",
};

const SECRETS = [
  ENV.OFFSITE_SOURCE_KEY,
  ENV.OFFSITE_SOURCE_KEY_SECRET,
  ENV.OFFSITE_DEST_KEY,
  ENV.OFFSITE_DEST_KEY_SECRET,
  ENV.OFFSITE_PING_URL,
];

/** The OFFSITE_* names the script reads. */
const READ_BY_SCRIPT = new Set(
  [...script.matchAll(/\b(OFFSITE_[A-Z_]+)\b/g)].map((match) => match[1]),
);

const sh = hasShell("sh");

describe.skipIf(!sh)("offsite-copy.sh", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
    // rclone: what reached its environment (names and values, for the
    // assertions), its own final stats line, and a failure on demand that
    // quotes the destination key, as an SDK error might.
    box.stub(
      "rclone",
      [
        `env | grep -E '^(RCLONE_CONFIG_|GOMEMLIMIT=)' >> "${box.root}/rclone.env"`,
        `echo '{"level":"notice","msg":"transferred","stats":{"bytes":2048,"checks":7,"deletes":0,"errors":0,"totalTransfers":3,"transfers":3},"source":"accounting"}' >&2`,
        `if [ -n "\${STUB_RCLONE_FAIL:-}" ]; then echo "AccessDenied: \${RCLONE_CONFIG_DST_ACCESS_KEY_ID} \${RCLONE_CONFIG_DST_SECRET_ACCESS_KEY}" >&2; exit 7; fi`,
      ].join("\n"),
    );
    box.stub("wget", "exit 0");
  });

  afterEach(() => box.dispose());

  function copy(env: Record<string, string> = {}) {
    return run("sh", repoFile(SCRIPT), [], {
      bin: box.bin,
      env: { STUB_RCLONE_FAIL: "", ...ENV, ...env },
    });
  }

  const rcloneEnv = () =>
    Object.fromEntries(
      readFileSync(`${box.root}/rclone.env`, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf("=");

          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );

  /** Every ping: its suffix and its body. */
  const pings = () =>
    box.calls("wget").map((line) => {
      const url = ENV.OFFSITE_PING_URL;
      const suffix = line.includes(`${url}/start`)
        ? "start"
        : line.includes(`${url}/fail`)
          ? "fail"
          : "success";
      const body = /--post-data (.*) https:\/\//.exec(line)?.[1] ?? "";

      return { suffix, body };
    });

  const expectNoSecret = (text: string) => {
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  };

  it("copies the two proof prefixes with copy, never sync, and never rewrites", () => {
    const { status, stdout, stderr } = copy();

    expect(status, stderr).toBe(0);

    const calls = box.calls("rclone");

    expect(calls).toHaveLength(1);

    const args = calls[0].split(" ").slice(1);

    expect(args.slice(0, 3)).toEqual([
      "copy",
      "src:trajetto-uploads",
      "dst:trajetto-offsite",
    ]);
    expect(calls[0]).toContain("--include /deliveryProofs/**");
    expect(calls[0]).toContain("--include /deliveryPhotos/**");

    for (const flag of [
      "--immutable",
      "--size-only",
      "--no-update-modtime",
      "--max-delete 0",
      "--buffer-size 0",
    ]) {
      expect(calls[0]).toContain(flag);
    }

    for (const verb of ["sync", "move", "delete", "deletefile", "purge"]) {
      expect(args).not.toContain(verb);
    }

    // The keys reach rclone through its environment, never its arguments.
    expectNoSecret(calls[0]);
    expect(rcloneEnv()).toMatchObject({
      RCLONE_CONFIG_SRC_TYPE: "s3",
      RCLONE_CONFIG_SRC_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_SRC_ENDPOINT: ENV.OFFSITE_SOURCE_ENDPOINT,
      RCLONE_CONFIG_SRC_ACCESS_KEY_ID: ENV.OFFSITE_SOURCE_KEY,
      RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY: ENV.OFFSITE_SOURCE_KEY_SECRET,
      RCLONE_CONFIG_SRC_NO_CHECK_BUCKET: "true",
      RCLONE_CONFIG_DST_TYPE: "s3",
      RCLONE_CONFIG_DST_ENDPOINT: ENV.OFFSITE_DEST_ENDPOINT,
      RCLONE_CONFIG_DST_ACCESS_KEY_ID: ENV.OFFSITE_DEST_KEY,
      RCLONE_CONFIG_DST_SECRET_ACCESS_KEY: ENV.OFFSITE_DEST_KEY_SECRET,
      RCLONE_CONFIG_DST_NO_CHECK_BUCKET: "true",
      GOMEMLIMIT: "40MiB",
    });

    const summary = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");

    expect(summary).toMatchObject({
      result: "ok",
      prefixes: "deliveryProofs/ deliveryPhotos/",
      transfers: 3,
      checks: 7,
      errors: 0,
      bytes: 2048,
    });

    expect(pings().map((ping) => ping.suffix)).toEqual(["start", "success"]);
    expect(pings()[1].body).toContain('"result":"ok"');
    expectNoSecret(stdout);
    expectNoSecret(stderr);
    for (const ping of pings()) expectNoSecret(ping.body);
  });

  it("fails with 3 and a redacted log when the copy fails", () => {
    const { status, stdout, stderr } = copy({ STUB_RCLONE_FAIL: "1" });

    expect(status).toBe(3);
    expect(stderr).toContain("copy-failed");
    expect(stderr).toContain("<redacted>");
    expectNoSecret(stdout);
    expectNoSecret(stderr);

    const fail = pings().find((ping) => ping.suffix === "fail");

    expect(fail?.body).toContain('"reason":"copy-failed"');
    expect(fail?.body).toContain("<redacted>");
    expectNoSecret(fail?.body ?? "");
  });

  it.each([
    ["a missing key", { OFFSITE_DEST_KEY: "" }, "OFFSITE_DEST_KEY"],
    [
      "the same account on both sides",
      { OFFSITE_DEST_ENDPOINT: "https://SOURCE-account.r2.example.com/" },
      "noutra conta",
    ],
    [
      "an endpoint without TLS",
      { OFFSITE_SOURCE_ENDPOINT: "http://source-account.r2.example.com" },
      "https://",
    ],
    [
      "an endpoint with a path",
      { OFFSITE_DEST_ENDPOINT: "https://dest-account.r2.example.com/bucket" },
      "sem caminho",
    ],
    [
      "a prefix without its slash",
      { OFFSITE_PREFIXES: "deliveryProofs" },
      "prefixo",
    ],
    [
      "a prefix that climbs",
      { OFFSITE_PREFIXES: "../deliveryProofs/" },
      "prefixo",
    ],
    [
      "a bucket that is no bucket name",
      { OFFSITE_DEST_BUCKET: "Off Site" },
      "bucket",
    ],
  ])("refuses %s, copying nothing", (_label, env, message) => {
    const { status, stderr } = copy(env);

    expect(status).toBe(1);
    expect(stderr).toContain(message);
    expect(box.calls("rclone")).toEqual([]);
    expect(pings().map((ping) => ping.suffix)).toEqual(["fail"]);
    expect(pings()[0].body).toContain('"reason":"config"');
    expectNoSecret(stderr);
  });

  it("copies only the prefixes it is given", () => {
    const { status } = copy({ OFFSITE_PREFIXES: "deliveryProofs/" });

    expect(status).toBe(0);
    expect(box.calls("rclone")[0]).toContain("--include /deliveryProofs/**");
    expect(box.calls("rclone")[0]).not.toContain("deliveryPhotos");
  });

  it("runs without a check to ping", () => {
    const { status } = copy({ OFFSITE_PING_URL: "" });

    expect(status).toBe(0);
    expect(box.calls("wget")).toEqual([]);
  });
});

describe("the script's text", () => {
  it("is POSIX sh, for the image's busybox", () => {
    const code = script
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    expect(script.split("\n")[0]).toBe("#!/bin/sh");

    // `$'…'` quoting, not a regex's `$` right before its closing quote.
    for (const bashism of [
      /\[\[/,
      /\blocal /,
      /\bfunction /,
      /(?:^|[\s=(])\$'/m,
      /pipefail/,
    ]) {
      expect(code).not.toMatch(bashism);
    }
  });

  it("never calls a verb of rclone that deletes", () => {
    expect(script).not.toMatch(
      /\brclone (?:sync|move|delete|deletefile|purge)\b/,
    );
    expect(script).toMatch(/set -- copy "src:/);
  });
});

describe("infra/r2/offsite-copy.md", () => {
  it("pins the official rclone image by digest, the same everywhere", () => {
    const images = [...doc.matchAll(/rclone\/rclone:[^\s`]+/g)].map(
      (match) => match[0],
    );

    expect(images.length).toBeGreaterThanOrEqual(2);
    expect(new Set(images).size).toBe(1);
    expect(images[0]).toMatch(
      /^rclone\/rclone:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
    );
  });

  it("starts the script the way the script's header says, from the file it mounts", () => {
    expect(script).toContain("#   sh /opt/trajetto/offsite-copy.sh");
    expect(doc).toContain("comando `sh /opt/trajetto/offsite-copy.sh`");
    expect(doc).toContain("`/opt/trajetto/offsite-copy.sh`");
  });

  it("caps the Application at the 64 MiB of the plan, weekly", () => {
    expect(doc).toContain("_Memory Limit_ `67108864`");
    expect(doc).toMatch(/cron `\d{1,2} \d{1,2} \* \* [0-6]`/);
  });

  it("expires the copy after its lock, as bucket-locks.md writes it", () => {
    const expiration = Number(
      /\| Expiration \(lifecycle\) \| (\d+) dias \|/.exec(doc)?.[1],
    );
    const lock = Number(/\| Bucket Lock +\| (\d+) dias \|/.exec(doc)?.[1]);
    const row = locks
      .split("\n")
      .find((line) => line.startsWith("| `trajetto-offsite`"));
    const cells = (row ?? "").split("|").map((cell) => cell.trim());

    expect(expiration).toBe(90);
    expect(lock).toBeLessThan(expiration);
    expect(Number(cells[3])).toBe(lock);
    expect(cells[4]).toContain(`Expiration de ${expiration} dias`);
  });

  it("documents every variable the script reads, here and in docs/variaveis-de-ambiente.md", () => {
    const table = new Set(
      [...doc.matchAll(/^\| `(OFFSITE_[A-Z_]+)`/gm)].map((match) => match[1]),
    );

    expect(READ_BY_SCRIPT.size).toBeGreaterThanOrEqual(10);
    expect([...table].sort()).toEqual([...READ_BY_SCRIPT].sort());

    for (const name of READ_BY_SCRIPT) {
      expect(variables, name).toContain(`\`${name}\``);
    }
  });
});
