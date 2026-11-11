import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * sibling's staging only when the sibling has no branch of that name.
 *
 * The probe is one step with the same name and id in the three repositories
 * ("Pick the sibling branches", `refs`). It used to be found through a list
 * of files, and a file that moved (ci.yml, browser-suites.yml, on
 * 10/11/2026) dropped out of the list without a word. Now every workflow and
 * every composite action of each repository present is read: every probe
 * found is run, and every checkout of a sibling must take its ref from a
 * probe of the same job. The same test holds before and after a sibling
 * moves its probe, so the API never has to wait for the web or the app.
 *
 * The step's own shell runs here, extracted from the YAML, with `git`
 * stubbed.
 */
const ROOT = process.cwd();

const bash = hasShell("bash");

const PROBE = "Pick the sibling branches";

/** Each repository, where it sits, and the siblings its probe asks about. */
const REPOSITORIES = [
  {
    repo: "trajetto-api",
    dir: ROOT,
    siblings: { web: "trajetto-ui", app: "trajetto-mobile" },
  },
  {
    repo: "trajetto-ui",
    dir: resolve(ROOT, "..", "trajetto-ui"),
    siblings: { api: "trajetto-api" },
  },
  {
    repo: "trajetto-mobile",
    dir: resolve(ROOT, "..", "trajetto-mobile"),
    siblings: { api: "trajetto-api" },
  },
] as const;

/** This repository's own probe: the composite action both jobs call. */
const OWN = ".github/actions/siblings/action.yml";

const PRESENT = REPOSITORIES.filter(({ dir }) =>
  existsSync(resolve(dir, "package.json")),
);

const read = (path: string) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Every workflow and composite action of a repository, by relative path. */
function ciFiles(dir: string): string[] {
  const files: string[] = [];
  const workflows = resolve(dir, ".github", "workflows");
  const actions = resolve(dir, ".github", "actions");

  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows).sort()) {
      if (/\.ya?ml$/.test(name)) files.push(`.github/workflows/${name}`);
    }
  }

  if (existsSync(actions)) {
    for (const name of readdirSync(actions).sort()) {
      if (existsSync(resolve(actions, name, "action.yml"))) {
        files.push(`.github/actions/${name}/action.yml`);
      }
    }
  }

  return files;
}

const indentOf = (line: string) => line.search(/\S/);

/** The step that starts at line `at` (its `- name:`), up to the next one. */
function stepAt(lines: string[], at: number): string[] {
  const dash = indentOf(lines[at]);
  const body = [lines[at]];

  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trim() !== "" && indentOf(line) <= dash) break;

    body.push(line);
  }

  return body;
}

/** The `run: |` script of a step, dedented. */
function runOf(step: string[]): string {
  const at = step.findIndex((line) => /^\s+run: \|$/.test(line));

  if (at < 0) return "";

  const indent = indentOf(step[at]) + 2;
  const body: string[] = [];

  for (const line of step.slice(at + 1)) {
    if (line.trim() !== "" && indentOf(line) < indent) break;

    body.push(line.slice(indent));
  }

  return body.join("\n");
}

/** A job's key (two spaces under `jobs:`): where one job ends. */
const JOB_KEY = /^ {2}[\w-]+:\s*$/;

interface Probe {
  /** `<repository>/<file>#<n>`, the n-th probe of that file. */
  label: string;
  repo: string;
  file: string;
  /** The whole step, as written. */
  step: string;
  /** Its `run:` script. */
  script: string;
  siblings: Record<string, string>;
}

interface Checkout {
  label: string;
  key: string;
  /** The line after `repository:`, trimmed. */
  ref: string;
  /** A probe earlier in the same job (or action). */
  probed: boolean;
}

/**
 * A `repository:` line, quoted or not. GitHub's owner and repository names
 * ignore case (`trajetto-organization/trajetto-api` is how the GHCR names
 * are written), so a sibling is recognised by its name in any case, and a
 * checkout written another way never slips past the rules below.
 */
const REPOSITORY = /^\s+repository:\s*(["']?)(.+?)\1\s*$/;

interface Repository {
  label: string;
  /** As written. */
  value: string;
  owner: string;
  /** Lowercased. */
  name: string;
}

const PROBES: Probe[] = [];
const CHECKOUTS: Checkout[] = [];
const REPOSITORIES_CHECKED_OUT: Repository[] = [];
const FILES = new Map<string, string[]>();

for (const { repo, dir, siblings } of PRESENT) {
  const keyOf = new Map<string, string>(
    Object.entries(siblings).map(([key, name]) => [name, key] as const),
  );

  FILES.set(repo, ciFiles(dir));

  for (const file of FILES.get(repo) ?? []) {
    const lines = read(resolve(dir, file)).split("\n");
    let probed = false;
    let count = 0;

    for (let at = 0; at < lines.length; at += 1) {
      const line = lines[at];

      if (JOB_KEY.test(line)) probed = false;

      if (line.trim() === `- name: ${PROBE}`) {
        const step = stepAt(lines, at);

        count += 1;
        probed = true;
        PROBES.push({
          label: `${repo}/${file}#${count}`,
          repo,
          file,
          step: step.join("\n"),
          script: runOf(step),
          siblings,
        });
      }

      const value = REPOSITORY.exec(line)?.[2];

      if (value === undefined) continue;

      const slash = value.lastIndexOf("/");
      const name = value.slice(slash + 1).toLowerCase();
      const key = keyOf.get(name);
      const label = `${repo}/${file}:${at + 1}`;

      REPOSITORIES_CHECKED_OUT.push({
        label,
        value,
        owner: slash < 0 ? "" : value.slice(0, slash),
        name,
      });

      if (key) {
        CHECKOUTS.push({
          label,
          key,
          ref: (lines[at + 1] ?? "").trim(),
          probed,
        });
      }
    }
  }
}

/** `git ls-remote` answers 0 only for the repositories that have the branch. */
const GIT = `
for repo in $STUB_HAS_BRANCH; do
  case "$*" in *"/$repo.git refs/heads/$BRANCH"*) exit 0 ;; esac
done
exit 2`;

const BRANCH = "feat/entregas-chat-e-hardening-2026-09";

describe("where the sibling probes are (TEST-CI-2)", () => {
  it("finds a probe in every repository present, and this one's in its own action", () => {
    for (const { repo } of PRESENT) {
      expect(
        PROBES.filter((probe) => probe.repo === repo).map(
          (probe) => probe.file,
        ),
        `${repo}: nenhum passo "${PROBE}" em ${FILES.get(repo)?.join(", ")}`,
      ).not.toEqual([]);
    }

    expect(
      PROBES.filter((probe) => probe.repo === "trajetto-api").map(
        (probe) => probe.label,
      ),
    ).toEqual([`trajetto-api/${OWN}#1`]);
  });

  it("is the same step in every probe: the id the checkouts read, the token and the branch", () => {
    for (const probe of PROBES) {
      expect(probe.step, probe.label).toMatch(/\n\s+id: refs\n/);
      expect(probe.step, probe.label).toMatch(/\n\s+TOKEN: \$\{\{ \S+ \}\}\n/);
      expect(probe.step, probe.label).toContain(
        "BRANCH: ${{ github.head_ref || github.ref_name }}",
      );
      expect(probe.script, probe.label).not.toBe("");
    }
  });

  // The two rules below hold for the checkouts they recognise. One whose
  // owner is an expression (`${{ github.repository_owner }}/...`) or another
  // organization, or whose name is an expression, would not be recognised,
  // and would test this branch against the sibling's default branch without
  // a word. So every checkout of another repository names this organization
  // and the repository, written out.
  it("names every checkout of another repository plainly: this organization, a literal name", () => {
    const siblingNames = new Set<string>(
      REPOSITORIES.flatMap(({ siblings }) => Object.values(siblings)),
    );

    expect(REPOSITORIES_CHECKED_OUT.length).toBeGreaterThanOrEqual(
      CHECKOUTS.length,
    );

    for (const each of REPOSITORIES_CHECKED_OUT) {
      expect(each.value, each.label).not.toContain("${{");
      expect(each.owner.toLowerCase(), each.label).toBe(
        "trajetto-organization",
      );
      expect(siblingNames.has(each.name), `${each.label}: ${each.value}`).toBe(
        true,
      );
    }
  });

  it("recognises a sibling's checkout written in any case, or quoted", () => {
    for (const line of [
      "          repository: trajetto-organization/trajetto-api",
      '          repository: "Trajetto-Organization/Trajetto-UI"',
      "          repository: 'TRAJETTO-ORGANIZATION/trajetto-mobile'",
    ]) {
      const value = REPOSITORY.exec(line)?.[2] ?? "";
      const name = value.slice(value.lastIndexOf("/") + 1).toLowerCase();

      expect(
        ["trajetto-api", "trajetto-ui", "trajetto-mobile"],
        line,
      ).toContain(name);
      expect(value, line).not.toMatch(/["']/);
    }

    expect(
      REPOSITORY.exec(
        "          repository: ${{ github.repository_owner }}/trajetto-api",
      )?.[2],
    ).toContain("${{");
  });

  // A checkout of a sibling that skipped the probe tested this branch against
  // whatever that checkout's default was.
  it("feeds the choice to every checkout of a sibling, in the same job", () => {
    expect(CHECKOUTS.length).toBeGreaterThanOrEqual(PROBES.length);

    for (const checkout of CHECKOUTS) {
      expect(checkout.probed, checkout.label).toBe(true);
      expect(checkout.ref, checkout.label).toBe(
        `ref: \${{ steps.refs.outputs.${checkout.key} }}`,
      );
    }
  });

  it("checks out every sibling a probe asks about", () => {
    for (const probe of PROBES) {
      for (const key of Object.keys(probe.siblings)) {
        expect(
          CHECKOUTS.some(
            (checkout) =>
              checkout.key === key &&
              checkout.label.startsWith(`${probe.repo}/${probe.file}:`),
          ),
          `${probe.label}: ${key}`,
        ).toBe(true);
      }
    }
  });
});

describe.skipIf(!bash || PROBES.length === 0)(
  "sibling checkouts in CI (TEST-CI-2)",
  () => {
    let box: Sandbox;

    beforeEach(() => {
      box = sandbox();
      box.stub("git", GIT);
      box.stub("sleep", "exit 0");
    });

    afterEach(() => box.dispose());

    function pick(script: string, hasBranch: string[]) {
      const file = box.file("pick.sh", script);
      const output = `${box.root}/github-output`;

      writeFileSync(output, "");

      const result = run("bash", file, [], {
        bin: box.bin,
        env: {
          TOKEN: "read-token-never-printed",
          BRANCH,
          GITHUB_OUTPUT: output,
          STUB_HAS_BRANCH: hasBranch.join(" "),
        },
      });

      return { ...result, outputs: readFileSync(output, "utf8") };
    }

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

    it.each(PROBES)(
      "$label checks out the same branch when the sibling has it",
      ({ script, siblings }) => {
        const result = pick(script, Object.values(siblings));

        expect(result.status, result.stderr).toBe(0);

        for (const key of Object.keys(siblings)) {
          expect(result.outputs).toContain(`${key}=${BRANCH}\n`);
        }
      },
    );

    it.each(PROBES)(
      "$label falls back, with a notice, never to a branch of another name",
      ({ script, siblings }) => {
        const result = pick(script, []);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/::notice::/);

        // The sibling's staging, where work branches come from and go back
        // to: never its default branch (main can be behind staging), and
        // never the work branch the sibling just said it does not have.
        // Every probe writes it, the old layouts' included (since
        // 30/10/2026).
        for (const key of Object.keys(siblings)) {
          const ref = new RegExp(`^${key}=(.*)$`, "m").exec(result.outputs);

          expect(ref?.[1], key).toBe("staging");
        }
      },
    );

    it.each(PROBES)(
      "$label authenticates the probe without printing the token",
      ({ script }) => {
        const result = pick(script, []);
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
    it.each(PROBES)(
      "$label clears the inherited Authorization header before sending its own",
      ({ script }) => {
        pick(script, []);

        const reset = "http.https://github.com/.extraheader=";
        const calls = box.calls("git");

        expect(calls.length).toBeGreaterThan(0);

        for (const call of calls) {
          expect(call).toContain(`${reset} -c ${reset}AUTHORIZATION: basic `);
        }
      },
    );

    /**
     * Only "no such branch" falls back: `ls-remote --exit-code` answers 2 for
     * it. A network or credential error (128) used to fall back too,
     * silently, and tested this branch against the sibling's default one.
     * Every probe asks again, with a warning, and then fails saying why: the
     * three repositories differ only in how many times (3 here and in the
     * app, 4 in the web).
     */
    it.each(PROBES)(
      "$label asks again after a network error, with a warning, and goes on",
      ({ script, siblings }) => {
        flaky([128, 0]);

        const result = pick(script, []);

        expect(result.status, result.stderr).toBe(0);

        for (const key of Object.keys(siblings)) {
          expect(result.outputs).toContain(`${key}=${BRANCH}\n`);
        }

        expect(result.stdout).toMatch(/::warning::.*128/);
        expect(box.calls("sleep")).toHaveLength(1);
      },
    );

    it.each(PROBES)(
      "$label fails, instead of testing against a fallback, when GitHub never answers",
      ({ script, siblings }) => {
        flaky([128]);

        const result = pick(script, []);
        const [first] = Object.values(siblings);
        const tries = box.calls("git").length;

        expect(result.status).toBe(1);
        expect(result.outputs).toBe("");
        expect(tries).toBeGreaterThanOrEqual(3);
        expect(box.calls("sleep")).toHaveLength(tries - 1);
        expect(result.stdout).toMatch(new RegExp(`::error::.*${first}`));
      },
    );

    /** This repository's probe, to the letter: what the docs promise. */
    describe(`this repository's probe (${OWN})`, () => {
      const own = PROBES.find(
        (probe) => probe.repo === "trajetto-api" && probe.file === OWN,
      );
      const script = own?.script ?? "";

      it("says, with a notice, that it falls back to the sibling's staging when the sibling has no such branch", () => {
        const result = pick(script, []);

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

        const result = pick(script, []);

        expect(result.status, result.stderr).toBe(0);
        expect(result.outputs).toBe(`web=${BRANCH}\napp=staging\n`);
        expect(result.stdout).toMatch(
          /::warning::A consulta das branches de trajetto-ui falhou \(git ls-remote, código 128; tentativa 1 de 3\)/,
        );
        expect(box.calls("sleep")).toEqual(["sleep 10"]);
      });

      it("fails, instead of testing against a fallback, when GitHub never answers", () => {
        flaky([128]);

        const result = pick(script, []);

        expect(result.status).toBe(1);
        expect(result.outputs).toBe("");
        expect(box.calls("git")).toHaveLength(3);
        expect(box.calls("sleep")).toEqual(["sleep 10", "sleep 20"]);
        expect(result.stdout).toMatch(
          /::error::Não deu para consultar as branches de trajetto-ui no GitHub depois de 3 tentativas/,
        );
      });
    });
  },
);
