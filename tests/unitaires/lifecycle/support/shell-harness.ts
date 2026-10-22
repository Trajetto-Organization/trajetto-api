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

export function run(
  shell: "sh" | "bash",
  script: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; bin?: string } = {},
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

  const result = spawnSync(shell, [posix(script), ...args], {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Absolute path of a file in this repository. */
export const repoFile = (...parts: string[]) =>
  posix(resolve(process.cwd(), ...parts));
