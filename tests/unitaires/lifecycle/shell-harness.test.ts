import { describe, expect, it } from "vitest";

import { hasShell, run, sandbox } from "./support/shell-harness";

/**
 * The harness that runs the repository's shell scripts for real
 * (support/shell-harness.ts), on what it does when a script does not end.
 *
 * Its kill timeout was 30 s, and a kill came back as an ordinary result:
 * status null and the output so far. In a full parallel run on a loaded
 * Windows machine — every Git Bash fork slower — the retry loop of ghcr.sh
 * (five attempts, a dozen processes each) crossed it, and
 * staging-deploy-workflow read the half-written stderr as "the script did
 * not say GHCR is down": a wrong verdict from a stopwatch. The kill is now a
 * guard against a hang only, far above any honest run, and hitting it
 * throws, naming the script, instead of handing a partial run to the
 * assertions.
 */
describe.skipIf(!hasShell("bash"))("the shell harness", () => {
  it("throws, naming the script, when the hang guard kills it, instead of returning half its output", () => {
    const box = sandbox();

    try {
      const script = box.file(
        "never-ends.sh",
        'echo "started" >&2\nsleep 30\necho "finished" >&2\n',
      );

      expect(() => run("bash", script, [], { hangGuardMs: 1_000 })).toThrow(
        /never-ends\.sh.*não terminou em 1 s/,
      );
    } finally {
      box.dispose();
    }
  });

  it("returns the run of a script that ends, with its status and output", () => {
    const box = sandbox();

    try {
      const script = box.file(
        "ends.sh",
        'echo "out"\necho "err" >&2\nexit 3\n',
      );

      expect(run("bash", script, [])).toEqual({
        status: 3,
        stdout: "out\n",
        stderr: "err\n",
      });
    } finally {
      box.dispose();
    }
  });
});
