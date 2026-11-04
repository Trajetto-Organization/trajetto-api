import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * Runs the repository's shell scripts for real, with the external commands
 * they call (docker, pg_dump, rclone, curl, npx...) replaced by stubs placed
 * first on PATH.
 *
 * The scripts are what production runs, so reading them as text proves
 * little: a truncated dump left on disk or a seed failure swallowed by `||`
 * only shows when the script executes. The stubs record every call, so a test
 * can say what was — and what was never — invoked.
 *
 * Paths are handed over with forward slashes: Git Bash on a Windows machine
 * accepts `C:/...` everywhere, while a backslash inside a script is an escape.
 */

export const posix = (path: string) => path.replace(/\\/g, "/");

/**
 * Whether `name` (sh, bash) can run this repository's scripts here. CI and
 * Git Bash: yes. A `bash` that resolves to WSL on a Windows shell starts fine
 * but cannot read `C:/...` paths, so the probe reads a file of the repository
 * instead of only running `exit 0` — those tests are skipped, not failed.
 */
export function hasShell(name: "sh" | "bash"): boolean {
  const probe = spawnSync(
    name,
    ["-c", `test -r "${posix(resolve(process.cwd(), "package.json"))}"`],
    { encoding: "utf8" },
  );

  return !probe.error && probe.status === 0;
}

export interface Sandbox {
  /** Root of a throwaway directory, removed by `dispose`. */
  root: string;
  /** Directory prepended to PATH, holding the stubs. */
  bin: string;
  /** File every stub appends its invocation to: `<name> <args...>`. */
  log: string;
  /** Writes an executable stub. The body runs after the call is logged. */
  stub(name: string, body: string): void;
  /** Writes a plain file under root and returns its path. */
  file(relative: string, content: string): string;
  /** Lines of the call log, optionally only those of one command. */
  calls(command?: string): string[];
  dispose(): void;
}

export function sandbox(): Sandbox {
  const root = posix(mkdtempSync(join(tmpdir(), "trajetto-sh-")));
  const bin = `${root}/bin`;
  const log = `${root}/calls.log`;

  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");

  return {
    root,
    bin,
    log,
    stub(name, body) {
      const path = `${bin}/${name}`;

      writeFileSync(
        path,
        `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`,
      );
      chmodSync(path, 0o755);
    },
    file(relative, content) {
      const path = posix(resolve(root, relative));

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);

      return path;
    },
    calls(command) {
      const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);

      return command
        ? lines.filter(
            (line) => line.startsWith(`${command} `) || line === command,
          )
        : lines;
    },
    dispose() {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * How long a script may run before it is taken for hung: a guard against a
 * hang, never a measure of speed. It was 30 s, and a kill came back as an
 * ordinary result (status null, the output so far). In a full parallel run
 * on a loaded Windows machine, where every Git Bash fork is slower, the
 * retry loop of ghcr.sh (five attempts, a dozen processes each) crossed it,
 * and staging-deploy-workflow read the half-written stderr as a wrong
 * answer. The slowest honest run measured is a few seconds; this is far
 * above any of them, and hitting it throws instead (see `run`).
 */
const HANG_GUARD_MS = 300_000;

export function run(
  shell: "sh" | "bash",
  script: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    bin?: string;
    /** Only the harness's own test lowers it. */
    hangGuardMs?: number;
  } = {},
): RunResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options.env,
  };

  if (options.bin) {
    // Windows spells it `Path`; two spellings in one block is ambiguous.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") delete env[key];
    }

    env.PATH = `${options.bin}${delimiter}${process.env.PATH}`;
  }

  const hangGuardMs = options.hangGuardMs ?? HANG_GUARD_MS;

  const result = spawnSync(shell, [posix(script), ...args], {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    timeout: hangGuardMs,
  });

  // Killed by the guard (or by anything else): not a run to judge. Its
  // partial output must never reach an assertion as if the script had
  // ended there.
  if (
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    result.signal
  ) {
    throw new Error(
      `shell-harness: ${posix(script)} não terminou em ${hangGuardMs / 1000} s ` +
        `e foi encerrado (${result.signal ?? "timeout"}); travou? ` +
        `stderr até ali: ${(result.stderr ?? "").slice(-500)}`,
    );
  }

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Absolute path of a file in this repository. */
export const repoFile = (...parts: string[]) =>
  posix(resolve(process.cwd(), ...parts));
