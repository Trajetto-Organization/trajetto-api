import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The workflows and the composite actions read as text, the way the other
 * lifecycle tests read them (no YAML dependency): jobs are the two-space
 * keys under `jobs:`, a job's steps the `- name:` items at six spaces, an
 * action's steps the `- name:` items at four spaces under `runs:`, and a
 * step's script its `run:` value.
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
  /** The `uses:` of a job that calls a reusable workflow, or undefined. */
  uses?: string;
}

export interface Workflow {
  file: string;
  text: string;
  jobs: Job[];
}

/** A composite action: `.github/actions/<name>/action.yml`. */
export interface Action {
  name: string;
  file: string;
  text: string;
  steps: Step[];
}

const ROOT = process.cwd();

export const WORKFLOW_DIR = resolve(ROOT, ".github", "workflows");
export const ACTION_DIR = resolve(ROOT, ".github", "actions");

const readText = (path: string) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

export function readWorkflow(file: string): Workflow {
  return workflowOf(file, readText(resolve(WORKFLOW_DIR, file)));
}

/** A workflow from its text: a version of a file that is not on disk. */
export function workflowOf(file: string, text: string): Workflow {
  return { file, text, jobs: jobsOf(text) };
}

export function allWorkflows(): Workflow[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map(readWorkflow);
}

export function readAction(name: string): Action {
  const file = `.github/actions/${name}/action.yml`;

  return actionOf(name, file, readText(resolve(ROOT, file)));
}

/** A composite action from its text: a sibling's, or a version not on disk. */
export function actionOf(name: string, file: string, text: string): Action {
  const at = text.indexOf("\n  steps:\n");

  return {
    name,
    file,
    text,
    steps: at < 0 ? [] : stepsOf(text.slice(at), 4),
  };
}

export function allActions(): Action[] {
  if (!existsSync(ACTION_DIR)) return [];

  return readdirSync(ACTION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(resolve(ACTION_DIR, name, "action.yml")))
    .sort()
    .map(readAction);
}

/** The job `name` of a workflow; throws when it does not exist. */
export function jobOf(workflow: Workflow, name: string): Job {
  const found = workflow.jobs.find((each) => each.name === name);

  if (!found) throw new Error(`${workflow.file}: no job ${name}`);

  return found;
}

/** The step `name` of a job or an action; throws when it does not exist. */
export function stepOf(owner: Job | Action, name: string): Step {
  const found = owner.steps.find((each) => each.name === name);

  if (!found) throw new Error(`${owner.name}: no step ${name}`);

  return found;
}

/** The steps' names, in order. */
export const stepNames = (owner: Job | Action) =>
  owner.steps.map((each) => each.name);

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
  const uses = /^ {4}uses: (\S+)\s*$/m.exec(text)?.[1];

  return { name, text, steps: stepsOf(text, 6), uses };
}

function stepsOf(text: string, indent: number): Step[] {
  return text
    .split(new RegExp(`\\n {${indent}}- name: `))
    .slice(1)
    .map((chunk) => {
      // A step ends where the next key of its parent begins.
      const end = chunk.search(new RegExp(`\\n {0,${indent - 2}}\\S`));
      const body = end < 0 ? chunk : chunk.slice(0, end);
      const name = body.split("\n")[0].trim();

      return { name, text: body, run: runOf(body) };
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

/**
 * A job's `needs`, from its text: `needs: a`, `needs: [a, b]`, or the same
 * list wrapped one name per line, which Prettier writes once the line
 * passes 80 columns (validate.yml's Result since the PgBouncer image job).
 */
export function needsOf(text: string): string[] {
  const head = /^ {4}needs:(.*)$/m.exec(text);

  if (!head) return [];

  const rest = text.slice(head.index + head[0].length + 1);
  const wrapped = /^(?: {6,}.*(?:\n|$))*/.exec(rest)?.[0] ?? "";

  return `${head[1]}\n${wrapped}`
    .replace(/[[\],]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** A step's `if:` expression, or "" when it has none. */
export function conditionOf(step: Step): string {
  return /\n\s+if: (.+)\n/.exec(`${step.text}\n`)?.[1]?.trim() ?? "";
}
