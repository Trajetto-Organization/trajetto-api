import { writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasShell,
  repoFile,
  run,
  sandbox,
  type Sandbox,
} from "./support/shell-harness";

/**
 * .github/scripts/ghcr.sh: how deploy.yml reads and moves tags in GHCR.
 *
 * Every query was `docker buildx imagetools inspect … 2>/dev/null || true`:
 * a 5xx, a timeout or a missing login read as "this tag does not exist". The
 * AI was rebuilt for nothing, staging lost the digest a failed deploy puts
 * back, the promote blamed a squash merge for a registry hiccup, and the
 * check that staging ran the AI image was skipped (fail-open). Now only
 * GHCR's own "not found" is an empty answer; anything else is retried with
 * growing pauses and then fails, naming GHCR.
 *
 * Run for real, with `docker` answering from a script of replies and `sleep`
 * recorded instead of slept.
 */
const SCRIPT = repoFile(".github", "scripts", "ghcr.sh");
const DIGEST = `sha256:${"a".repeat(64)}`;
const REF = "ghcr.io/trajetto-organization/trajetto-ai:src-1234";
const TARGET_ONLY = "ghcr.io/trajetto-organization/trajetto-api:staging";

describe.skipIf(!hasShell("bash"))("ghcr.sh", { timeout: 30_000 }, () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
    box.stub("sleep", "exit 0");
  });

  afterEach(() => box.dispose());

  /** Each docker call answers the next reply: [exit code, stdout, stderr]. */
  function docker(replies: Array<[number, string, string]>) {
    writeFileSync(
      `${box.root}/replies`,
      replies.map((reply) => reply.join("|")).join("\n") + "\n",
    );
    writeFileSync(`${box.root}/n`, "0");
    box.stub(
      "docker",
      [
        `n=$(cat "${box.root}/n"); echo $((n + 1)) > "${box.root}/n"`,
        `line=$(sed -n "$((n + 1))p" "${box.root}/replies")`,
        `[ -n "$line" ] || line=$(tail -n 1 "${box.root}/replies")`,
        "code=${line%%|*}; rest=${line#*|}; out=${rest%%|*}; err=${rest#*|}",
        '[ -z "$out" ] || printf "%s\\n" "$out"',
        '[ -z "$err" ] || printf "%s\\n" "$err" >&2',
        'exit "$code"',
      ].join("\n"),
    );
  }

  const ghcr = (...args: string[]) => {
    const result = run("bash", SCRIPT, args, { bin: box.bin });

    return {
      ...result,
      calls: box.calls("docker"),
      sleeps: box.calls("sleep"),
    };
  };

  describe("digest", () => {
    it("prints the digest of a tag that exists, asking once", () => {
      docker([[0, DIGEST, ""]]);

      const result = ghcr("digest", REF);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${DIGEST}\n`);
      expect(result.calls).toEqual([
        `docker buildx imagetools inspect ${REF} --format {{.Manifest.Digest}}`,
      ]);
    });

    it.each([
      [`ERROR: ${REF}: not found`],
      ["ERROR: failed to resolve: MANIFEST_UNKNOWN: manifest unknown"],
      ["ERROR: NAME_UNKNOWN: repository name not known to registry"],
    ])(
      "answers nothing, at once, when GHCR says the tag does not exist (%s)",
      (err) => {
        docker([[1, "", err]]);

        const result = ghcr("digest", REF);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.calls).toHaveLength(1);
        expect(result.sleeps).toEqual([]);
      },
    );

    it("tries a transport error again, warning with the count, and doubles the pause", () => {
      docker([
        [
          1,
          "",
          "ERROR: unexpected status from HEAD request: 503 Service Unavailable",
        ],
        [1, "", "ERROR: read tcp: connection reset by peer"],
        [0, DIGEST, ""],
      ]);

      const result = ghcr("digest", REF);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${DIGEST}\n`);
      expect(result.calls).toHaveLength(3);
      expect(result.sleeps).toEqual(["sleep 5", "sleep 10"]);
      expect(result.stderr).toMatch(
        /::warning::GHCR: falha ao ler .*tentativa 1 de 5.*503/,
      );
      expect(result.stderr).toMatch(
        /::warning::GHCR: .*tentativa 2 de 5.*connection reset/,
      );
    });

    it("fails, naming GHCR, when it never answers — never an empty 'not found'", () => {
      docker([[1, "", "ERROR: denied: unauthorized"]]);

      const result = ghcr("digest", REF);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.calls).toHaveLength(5);
      expect(result.stderr).toMatch(
        /::error::GHCR indisponível: não deu para ler .* depois de 5 tentativas\. Último erro: ERROR: denied: unauthorized/,
      );
    });

    it("reads the digest from the manifest header a newer buildx prints instead", () => {
      // buildx 0.30 prints this for any template that starts with
      // `{{.Manifest` (measured on 30/10/2026): the index's own digest, then
      // its manifests, whose digests sit in "Name:" lines and annotations —
      // never in a "Digest:" line. The runners' buildx prints the bare
      // digest; a runner image update must not read as "GHCR is down".
      const child = `sha256:${"b".repeat(64)}`;
      const header = [
        `Name:      ${REF}`,
        "MediaType: application/vnd.oci.image.index.v1+json",
        `Digest:    ${DIGEST}`,
        "           ",
        "Manifests: ",
        `  Name:        ${REF}@${child}`,
        "  MediaType:   application/vnd.oci.image.manifest.v1+json",
        "  Platform:    unknown/unknown",
        "  Annotations: ",
        `    vnd.docker.reference.digest: ${child}`,
        "    vnd.docker.reference.type:   attestation-manifest",
      ];

      writeFileSync(`${box.root}/header`, `${header.join("\r\n")}\r\n`);
      box.stub("docker", `cat "${box.root}/header"`);

      const result = ghcr("digest", REF);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${DIGEST}\n`);
      expect(box.calls("docker")).toHaveLength(1);
    });

    it("does not take an unreadable answer for a digest", () => {
      docker([[0, "garbage", ""]]);

      const result = ghcr("digest", REF);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/resposta ilegível do GHCR: garbage/);
    });

    it("honours GHCR_ATTEMPTS and GHCR_RETRY_SECONDS", () => {
      docker([[1, "", "ERROR: 502 Bad Gateway"]]);

      const result = run("bash", SCRIPT, ["digest", REF], {
        bin: box.bin,
        env: { GHCR_ATTEMPTS: "2", GHCR_RETRY_SECONDS: "1" },
      });

      expect(result.status).toBe(1);
      expect(box.calls("docker")).toHaveLength(2);
      expect(box.calls("sleep")).toEqual(["sleep 1"]);
    });
  });

  describe("tag", () => {
    const TARGET = "ghcr.io/trajetto-organization/trajetto-api:staging";
    const SOURCE = `ghcr.io/trajetto-organization/trajetto-api@${DIGEST}`;

    it("moves the tag registry-side, once", () => {
      docker([[0, "", ""]]);

      const result = ghcr("tag", TARGET, SOURCE);

      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toEqual([
        `docker buildx imagetools create --tag ${TARGET} ${SOURCE}`,
      ]);
    });

    it("tries a failed move again: the same digest under the same name is idempotent", () => {
      docker([
        [1, "", "ERROR: failed to push: 500 Internal Server Error"],
        [0, "", ""],
      ]);

      const result = ghcr("tag", TARGET, SOURCE);

      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toHaveLength(2);
      expect(result.stderr).toMatch(
        /::warning::GHCR: falha ao apontar .*tentativa 1 de 5/,
      );
    });

    it("fails at once when the source does not exist", () => {
      docker([[1, "", `ERROR: ${SOURCE}: not found`]]);

      const result = ghcr("tag", TARGET, SOURCE);

      expect(result.status).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.stderr).toMatch(
        /::error::GHCR: não deu para apontar .*a origem não existe/,
      );
    });
  });

  it("refuses a call it does not know", () => {
    docker([[0, DIGEST, ""]]);

    for (const args of [
      [],
      ["digest"],
      ["tag", TARGET_ONLY],
      ["inspect", REF],
    ]) {
      const result = ghcr(...args);

      expect(result.status, args.join(" ")).toBe(2);
    }

    expect(box.calls("docker")).toEqual([]);
  });
});
