import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasShell, run, sandbox, type Sandbox } from "./support/shell-harness";

/**
 * The CI jobs that check a sibling repository out next to this one.
 *
 * They checked out the sibling's DEFAULT branch. On a change that spans the
 * repositories — this phase's feat/entregas-chat-e-hardening-2026-09 exists
 * in all three — client-routes tested this API branch against the web and the
 * app of `main`, and the socket tests of the web and the app ran against the
 * API of `main`: false failures, or false passes, exactly when routes and
 * events change on both sides. Now the same branch goes first, and the
 * default one only when the sibling has no branch of that name.
 *
 * The step's own shell runs here, extracted from the YAML, with `git`
 * stubbed.
 */
const ROOT = process.cwd();
const REPOS = resolve(ROOT, "..");

const bash = hasShell("bash");

interface Case {
  file: string;
  siblings: Record<string, string>;
}

const ALL: Case[] = [
  {
    file: "trajetto-api/.github/workflows/ci.yml",
    siblings: { web: "trajetto-ui", app: "trajetto-mobile" },
  },
  {
    file: "trajetto-ui/.github/workflows/ci.yml",
    siblings: { api: "trajetto-api" },
  },
  {
    file: "trajetto-mobile/.github/workflows/ci.yml",
    siblings: { api: "trajetto-api" },
  },
  {
    file: "trajetto-ui/.github/workflows/browser-suites.yml",
    siblings: { api: "trajetto-api" },
  },
];

const CASES = ALL.filter((each) => existsSync(resolve(REPOS, each.file)));

const read = (file: string) =>
  readFileSync(resolve(REPOS, file), "utf8").replace(/\r\n/g, "\n");

/** The `run: |` block of the step called `name`, dedented. */
function runBlock(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);

  if (at < 0) return "";

  let index = at + 1;

  while (index < lines.length && !/^\s+run: \|$/.test(lines[index])) index += 1;

  const indent = lines[index].search(/\S/) + 2;
  const body: string[] = [];

  for (let line = index + 1; line < lines.length; line += 1) {
    if (lines[line].trim() !== "" && lines[line].search(/\S/) < indent) break;

    body.push(lines[line].slice(indent));
  }

  return body.join("\n");
}

/** `git ls-remote` answers 0 only for the repositories that have the branch. */
const GIT = `
for repo in $STUB_HAS_BRANCH; do
  case "$*" in *"/$repo.git refs/heads/$BRANCH"*) exit 0 ;; esac
done
exit 2`;

describe.skipIf(!bash || CASES.length === 0)(
  "sibling checkouts in CI (TEST-CI-2)",
  () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
      box.stub("git", GIT);
    });

    afterEach(() => box.dispose());

    function pick(workflow: string, hasBranch: string[]) {
      const script = box.file(
        "pick.sh",
        runBlock(workflow, "Pick the sibling branches"),
      );
      const output = `${box.root}/github-output`;

      writeFileSync(output, "");

      const result = run("bash", script, [], {
        bin: box.bin,
        env: {
          TOKEN: "read-token-never-printed",
          BRANCH: "feat/entregas-chat-e-hardening-2026-09",
          GITHUB_OUTPUT: output,
          STUB_HAS_BRANCH: hasBranch.join(" "),
        },
      });

      return { ...result, outputs: readFileSync(output, "utf8") };
    }

    it.each(CASES)(
      "$file checks out the same branch when the sibling has it",
      ({ file, siblings }) => {
        const [[key, repo]] = Object.entries(siblings);
        const result = pick(read(file), [repo]);

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toContain(
          `${key}=feat/entregas-chat-e-hardening-2026-09\n`,
        );
      },
    );

    it.each(CASES)(
      "$file falls back, with a notice, never to a branch of another name",
      ({ file, siblings }) => {
        const result = pick(read(file), []);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/::notice::/);

        // The sibling's staging (since 30/10/2026; this repository's own probe
        // is pinned exactly below), or, in a sibling still on the older probe,
        // no ref at all: the checkout's default branch. Never the work branch
        // the sibling just said it does not have.
        for (const key of Object.keys(siblings)) {
          const ref = new RegExp(`^${key}=(.*)$`, "m").exec(result.outputs);

          expect([undefined, "staging"]).toContain(ref?.[1]);
        }
      },
    );

    it.each(CASES)(
      "$file authenticates the probe without printing the token",
      ({ file }) => {
        const result = pick(read(file), []);
        const encoded = Buffer.from(
          "x-access-token:read-token-never-printed",
        ).toString("base64");

        expect(
          box
            .calls("git")
            .every((call) => call.includes(`AUTHORIZATION: basic ${encoded}`)),
        ).toBe(true);
        expect(result.stdout + result.stderr).not.toContain(
          "read-token-never-printed",
        );
        expect(result.stdout + result.stderr).not.toContain(encoded);
      },
    );

    // The workflow's own checkout persists an Authorization extraheader in the
    // repository's git config; adding ours on top sent two, GitHub answered
    // 400 "Duplicate header", and the probe fell back to the default branch
    // as if the sibling had no such branch. An empty value resets the list.
    it.each(CASES)(
      "$file clears the inherited Authorization header before sending its own",
      ({ file }) => {
        pick(read(file), []);

        const reset = "http.https://github.com/.extraheader=";
        const calls = box.calls("git");

        expect(calls.length).toBeGreaterThan(0);

        for (const call of calls) {
          expect(call).toContain(`${reset} -c ${reset}AUTHORIZATION: basic `);
        }
      },
    );

    /**
     * Only "no such branch" falls back, to the sibling's staging (where work
     * branches come from; main can be behind it): `ls-remote --exit-code`
     * answers 2 for it. A network or credential error (128) used
     * to fall back too, silently, and tested this branch against the
     * sibling's default one. Checked on this repository's own workflow only:
     * the API's CI reads the siblings at their default branch, which moves on
     * its own schedule.
     */
    describe("this repository's probe (ci.yml)", () => {
      const own = "trajetto-api/.github/workflows/ci.yml";

      beforeEach(() => box.stub("sleep", "exit 0"));

      /** git answers each ls-remote with the next code; the last repeats. */
      function flaky(codes: number[]) {
        const counter = `${box.root}/git-count`;

        writeFileSync(counter, "0");
        box.stub(
          "git",
          [
            `n=$(cat "${counter}"); echo $((n + 1)) > "${counter}"`,
            `set -- ${codes.join(" ")}`,
            'i=0; code=0; for c in "$@"; do code=$c; i=$((i + 1)); [ "$i" -gt "$n" ] && break; done',
            'exit "$code"',
          ].join("\n"),
        );
      }

      it("says, with a notice, that it falls back to the sibling's staging when the sibling has no such branch", () => {
        const result = pick(read(own), []);

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toBe("web=staging\napp=staging\n");
        expect(result.stdout).toMatch(/::notice::trajetto-ui não tem a branch/);
        expect(result.stdout).toMatch(
          /::notice::trajetto-mobile não tem a branch/,
        );
      });

      it("asks again after a network error, with a warning, and goes on", () => {
        // trajetto-ui: 128, then the branch exists; trajetto-mobile: no branch.
        flaky([128, 0, 2]);

        const result = pick(read(own), []);

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toBe(
          "web=feat/entregas-chat-e-hardening-2026-09\napp=staging\n",
        );
        expect(result.stdout).toMatch(
          /::warning::A consulta das branches de trajetto-ui falhou \(git ls-remote, código 128; tentativa 1 de 3\)/,
        );
        expect(box.calls("sleep")).toEqual(["sleep 10"]);
      });

      it("fails, instead of testing against a fallback, when GitHub never answers", () => {
        flaky([128]);

        const result = pick(read(own), []);

        expect(result.status).toBe(1);
        expect(result.outputs).toBe("");
        expect(box.calls("git")).toHaveLength(3);
        expect(box.calls("sleep")).toEqual(["sleep 10", "sleep 20"]);
        expect(result.stdout).toMatch(
          /::error::Não deu para consultar as branches de trajetto-ui no GitHub depois de 3 tentativas/,
        );
      });
    });

    it.each(CASES)(
      "$file feeds the choice to every sibling checkout",
      ({ file, siblings }) => {
        const workflow = read(file);
        const probe = workflow.indexOf("- name: Pick the sibling branches");

        expect(probe).toBeGreaterThan(-1);
        expect(workflow).toContain(
          "BRANCH: ${{ github.head_ref || github.ref_name }}",
        );

        for (const [key, repo] of Object.entries(siblings)) {
          const checkout = workflow.indexOf(
            `repository: Trajetto-Organization/${repo}\n`,
          );

          expect(checkout, repo).toBeGreaterThan(probe);
          expect(workflow.slice(checkout).split("\n")[1].trim(), repo).toBe(
            `ref: \${{ steps.refs.outputs.${key} }}`,
          );
        }
      },
    );
  },
);
