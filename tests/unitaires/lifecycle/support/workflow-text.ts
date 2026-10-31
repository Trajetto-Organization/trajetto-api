import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The workflows read as text, the way the other lifecycle tests read them
 * (no YAML dependency): jobs are the two-space keys under `jobs:`, steps the
 * `- name:` items at six spaces, and a step's script its `run:` value.
 */

export interface Step {
  name: string;
  text: string;
  /** The `run:` script, dedented ("" when the step uses an action). */
  run: string;
}

export interface Job {
  name: string;
  text: string;
  steps: Step[];
}

export interface Workflow {
  file: string;
  text: string;
  jobs: Job[];
}

const ROOT = process.cwd();

export const WORKFLOW_DIR = resolve(ROOT, ".github", "workflows");

export function readWorkflow(file: string): Workflow {
  const text = readFileSync(resolve(WORKFLOW_DIR, file), "utf8").replace(
    /\r\n/g,
    "\n",
  );

  return { file, text, jobs: jobsOf(text) };
}

export function allWorkflows(): Workflow[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map(readWorkflow);
}

function jobsOf(workflow: string): Job[] {
  const lines = workflow.split("\n");
  const start = lines.indexOf("jobs:");

  if (start < 0) return [];

  const jobs: Job[] = [];
  let current: { name: string; lines: string[] } | null = null;

  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([\w-]+):\s*$/.exec(line);

    if (key) {
      if (current) jobs.push(finish(current));
      current = { name: key[1], lines: [line] };
      continue;
    }

    // A top-level key after the jobs ends them.
    if (/^\S/.test(line)) break;

    current?.lines.push(line);
  }

  if (current) jobs.push(finish(current));

  return jobs;
}

function finish({ name, lines }: { name: string; lines: string[] }): Job {
  const text = lines.join("\n");

  return { name, text, steps: stepsOf(text) };
}

function stepsOf(job: string): Step[] {
  return job
    .split(/\n {6}- name: /)
    .slice(1)
    .map((chunk) => {
      const name = chunk.split("\n")[0].trim();

      return { name, text: chunk, run: runOf(chunk) };
    });
}

function runOf(step: string): string {
  const lines = step.split("\n");
  const at = lines.findIndex((line) => /^\s+run:/.test(line));

  if (at < 0) return "";

  const inline = /^\s+run:\s*(.*)$/.exec(lines[at])?.[1] ?? "";

  if (inline !== "|" && inline !== "|-" && inline !== ">") return inline;

  const indent = lines[at].search(/\S/) + 2;
  const body: string[] = [];

  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;

    body.push(line.slice(indent));
  }

  return body.join("\n").replace(/\n+$/, "\n");
}

/** The job's own `timeout-minutes`, or undefined. */
export function timeoutOf(job: Job): number | undefined {
  const match = /^ {4}timeout-minutes: (\d+)\s*$/m.exec(job.text);

  return match ? Number(match[1]) : undefined;
}
