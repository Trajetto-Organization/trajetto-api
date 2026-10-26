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
      "$file falls back to the default branch when it does not",
      ({ file, siblings }) => {
        const result = pick(read(file), []);

        expect(result.status, result.stderr).toBe(0);

        // An empty `ref:` is the checkout action's default branch.
        for (const key of Object.keys(siblings))
          expect(result.outputs).not.toContain(`${key}=`);
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
