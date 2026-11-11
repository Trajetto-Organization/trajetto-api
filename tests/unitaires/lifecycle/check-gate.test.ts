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
 * .github/scripts/check-gate.sh: was the staging validation of a commit
 * green? The `Staging evidence` of the pull request into main and of the
 * promote ask it about the commit whose build ships, and about a head that
 * only adds documentation to it.
 *
 * The `staged-<7>` marker says staging deployed the build. This says the
 * Gate that let it through passed, from the github-actions app, in its
 * latest run, in a run of staging.yml on the staging branch — so "no answer
 * from GitHub" is never read as "not green", nor the other way round, and a
 * job called `Gate` anywhere else proves nothing.
 *
 * Run with `gh` stubbed: it prints what the API's check runs would give
 * through the script's own jq filter (one `name<TAB>status<TAB>conclusion
 * <TAB>suite` per line), and, for a check suite, its workflow run's
 * `path<TAB>branch`.
 */
const SCRIPT = repoFile(".github", "scripts", "check-gate.sh");
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const LEGACY = "Lint, type-check, unit (coverage floor) and E2E";
const STAGING = ".github/workflows/staging.yml\tstaging";

describe.skipIf(!hasShell("bash"))("check-gate.sh", () => {
  let box: Sandbox;

  beforeEach(() => {
    box = sandbox();
    box.stub("sleep", "exit 0");
  });

  afterEach(() => box.dispose());

  /**
   * `gh` answers the commit's check runs — `reads[i]` on the i-th read, the
   * last one after that — and each suite's run from `origins`; every call
   * first takes the next exit code of `codes` (the last one repeats).
   */
  function gh(
    reads: string[][][],
    origins: Record<string, string> = { "11": STAGING },
    codes: number[] = [0],
  ) {
    const counter = `${box.root}/gh.count`;
    const readCounter = `${box.root}/reads.count`;

    reads.forEach((rows, at) =>
      writeFileSync(
        `${box.root}/reads.${at}`,
        rows.map((each) => `${each.join("\t")}\n`).join(""),
      ),
    );
    writeFileSync(
      `${box.root}/origins`,
      Object.entries(origins)
        .map(([suite, origin]) => `${suite}\t${origin}\n`)
        .join(""),
    );
    writeFileSync(counter, "0");
    writeFileSync(readCounter, "0");
    box.stub(
      "gh",
      [
        'args="$*"',
        `n=$(cat "${counter}"); echo $((n + 1)) > "${counter}"`,
        `set -- ${codes.join(" ")}`,
        'i=0; code=0; for c in "$@"; do code=$c; i=$((i + 1)); [ "$i" -gt "$n" ] && break; done',
        '[ "$code" -eq 0 ] || { echo "HTTP 502" >&2; exit "$code"; }',
        'case "$args" in',
        "  *check_suite_id=*)",
        `    suite=$(printf '%s' "$args" | sed -E 's/.*check_suite_id=([0-9]+).*/\\1/')`,
        `    awk -F '\\t' -v s="$suite" '$1 == s { print $2 "\\t" $3 }' "${box.root}/origins"`,
        "    ;;",
        "  *)",
        `    m=$(cat "${readCounter}"); echo $((m + 1)) > "${readCounter}"`,
        `    f="${box.root}/reads.$m"; [ -f "$f" ] || f="${box.root}/reads.${reads.length - 1}"`,
        '    cat "$f"',
        "    ;;",
        "esac",
      ].join("\n"),
    );
  }

  function check(commit = SHA, env: Record<string, string> = {}) {
    const summary = `${box.root}/summary`;

    writeFileSync(summary, "");

    const result = run("bash", SCRIPT, [commit], {
      bin: box.bin,
      env: {
        GITHUB_REPOSITORY: "Trajetto-Organization/trajetto-api",
        GITHUB_STEP_SUMMARY: summary,
        ...env,
      },
    });

    return { ...result, log: result.stdout + result.stderr };
  }

  it("passes when staging.yml's Gate, on staging, completed with success", () => {
    gh([
      [
        ["Validate / Validate", "completed", "success", "11"],
        ["Gate", "completed", "success", "11"],
      ],
    ]);

    const result = check();

    expect(result.status, result.log).toBe(0);
    expect(result.log).toContain('"Gate" da validação de staging passou');
  });

  it("asks the API for this commit's check runs, from the github-actions app only, and for the run of the Gate's suite", () => {
    gh([[["Gate", "completed", "success", "11"]]]);
    check();

    const [runs, origin] = box.calls("gh");

    expect(runs).toContain(
      `api --paginate repos/Trajetto-Organization/trajetto-api/commits/${SHA}/check-runs?per_page=100`,
    );
    expect(runs).toContain('select(.app.slug == "github-actions")');
    expect(origin).toContain(
      "api --paginate repos/Trajetto-Organization/trajetto-api/actions/runs?check_suite_id=11",
    );
  });

  it.each([
    ["failed", ["Gate", "completed", "failure", "11"]],
    ["cancelled", ["Gate", "completed", "cancelled", "11"]],
    ["skipped (a superseded run)", ["Gate", "completed", "skipped", "11"]],
  ])("refuses a Gate that %s", (_, gate) => {
    gh([[gate]]);

    const result = check();

    expect(result.status).toBe(3);
    expect(result.log).toMatch(/não passou: "Gate"/);
  });

  // A job of that name in another workflow, or staging.yml dispatched on
  // another branch, would otherwise vouch for a commit staging never
  // validated.
  it.each([
    ["another workflow", ".github/workflows/ci.yml\tstaging"],
    ["staging.yml on another branch", ".github/workflows/staging.yml\tfeat/x"],
    ["staging.yml on main", ".github/workflows/staging.yml\tmain"],
    ["no workflow run at all", ""],
  ])("refuses a green Gate from %s", (_, origin) => {
    gh([[["Gate", "completed", "success", "11"]]], { "11": origin });

    const result = check();

    expect(result.status, result.log).toBe(3);
    expect(result.log).toMatch(
      /"Gate" verde, mas de .+, não de \.github\/workflows\/staging\.yml na staging/,
    );
  });

  it("takes a workflow path with a ref after it for the same file", () => {
    gh([[["Gate", "completed", "success", "11"]]], {
      "11": ".github/workflows/staging.yml@refs/heads/staging\tstaging",
    });

    expect(check().status).toBe(0);
  });

  it.each([
    [
      "still running",
      [["Gate", "in_progress", "", "11"]],
      /ainda não terminou/,
    ],
    ["queued", [["Gate", "queued", "", "11"]], /ainda não terminou/],
    [
      "absent",
      [["Validate / Validate", "completed", "success", "11"]],
      /não tem o check "Gate"/,
    ],
  ])(
    "answers not yet (4) for a Gate %s, without waiting by default",
    (_, rows, said) => {
      gh([rows]);

      const result = check();

      expect(result.status).toBe(4);
      expect(result.log).toMatch(said);
      expect(box.calls("sleep")).toEqual([]);
    },
  );

  it("waits for a Gate not yet finished when asked to, and takes its verdict", () => {
    gh([
      [["Validate / Docs", "in_progress", "", "11"]],
      [["Gate", "in_progress", "", "11"]],
      [["Gate", "completed", "success", "11"]],
    ]);

    const result = check(SHA, {
      GATE_WAIT_ROUNDS: "5",
      GATE_WAIT_SECONDS: "7",
    });

    expect(result.status, result.log).toBe(0);
    expect(box.calls("sleep")).toEqual(["sleep 7", "sleep 7"]);

    gh([
      [["Gate", "in_progress", "", "11"]],
      [["Gate", "completed", "failure", "11"]],
    ]);

    const red = check(SHA, { GATE_WAIT_ROUNDS: "5" });

    expect(red.status).toBe(3);
  });

  it("gives up, as not yet, when the wait runs out", () => {
    gh([[["Gate", "in_progress", "", "11"]]]);

    const result = check(SHA, { GATE_WAIT_ROUNDS: "3" });

    expect(result.status).toBe(4);
    expect(box.calls("sleep")).toHaveLength(3);
  });

  it("accepts the old pipeline's job, from deploy.yml on staging, for builds made before staging.yml", () => {
    const deployYml = { "11": ".github/workflows/deploy.yml\tstaging" };

    gh([[[LEGACY, "completed", "success", "11"]]], deployYml);

    expect(check().status).toBe(0);

    gh([[[LEGACY, "completed", "failure", "11"]]], deployYml);

    expect(check().status).toBe(3);

    gh([[[LEGACY, "completed", "success", "11"]]], {
      "11": ".github/workflows/ci.yml\tstaging",
    });

    expect(check().status).toBe(3);
  });

  it("asks GitHub again, and fails as GitHub's — never as a red gate — when it does not answer", () => {
    gh([[["Gate", "completed", "success", "11"]]], undefined, [1, 1, 0]);

    const flaky = check();

    expect(flaky.status, flaky.log).toBe(0);
    expect(flaky.log.match(/::warning::A API do GitHub falhou/g)).toHaveLength(
      2,
    );
    // Two failed reads, the check runs, the suite's run.
    expect(box.calls("gh")).toHaveLength(4);

    gh([[["Gate", "completed", "success", "11"]]], undefined, [1]);

    const down = check();

    expect(down.status).toBe(1);
    expect(down.log).toMatch(
      /::error::A API do GitHub não respondeu os checks/,
    );
  });

  it("fails as GitHub's when the run of the Gate's suite cannot be read", () => {
    gh([[["Gate", "completed", "success", "11"]]], undefined, [0, 1]);

    const result = check();

    expect(result.status, result.log).toBe(1);
    expect(result.log).toMatch(
      /::error::A API do GitHub não respondeu a origem do check/,
    );
  });

  it("refuses anything but a full sha", () => {
    gh([[["Gate", "completed", "success", "11"]]]);

    for (const commit of ["abcdef0", "", `${SHA};id`]) {
      const result = check(commit);

      expect(result.status, commit).toBe(1);
    }
    expect(box.calls("gh")).toEqual([]);
  });
});
