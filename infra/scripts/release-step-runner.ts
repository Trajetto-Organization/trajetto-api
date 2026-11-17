import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type pg from "pg";

/**
 * The steps after `prisma migrate deploy` (plano-escala F5-08, D17, D18):
 *
 *   prisma/concurrent → migrate deploy → infra/sql/*.sql → prisma/post-deploy/*.sql → seeds
 *
 * infra/sql holds what belongs to the cluster rather than to a migration:
 * roles, ownership and grants. It runs on EVERY release, in name order,
 * because a `pg_restore --no-owner` (a restore, a PITR, a failover) loses
 * grants and owners, and only a file reapplied every time converges again.
 * prisma/post-deploy holds DDL that waits for a precondition (the queue
 * swap waits until every live image announces a capability).
 *
 * Each file checks its own state and ends with a NOTICE that says what it
 * did: 'applied: …', 'skipped: …' (already done) or 'pending: …' (it waits
 * for a state; the next deploy runs the release step again, U-11). The last
 * such NOTICE is the step's status, kept in release_step_state with the
 * time; a file without one fails, and a file that left the repository turns
 * 'retired'. The run itself is the row '@release'.
 *
 * Between files the session is put back (role, timeouts): a step's SET must
 * not leak into the next one. Each file runs as one simple query, so a file
 * of several statements without BEGIN runs as one implicit transaction.
 */

const STEP_GROUPS = ["infra/sql", "prisma/post-deploy"] as const;

type StepGroup = (typeof STEP_GROUPS)[number];

type StepStatus = "applied" | "skipped" | "pending";

const RUN_ROW = "@release";

/** Lock waits of a step are bounded unless the file says otherwise. */
const STEP_LOCK_TIMEOUT = "5s";

/** What a release_step_state row keeps of a detail. */
const DETAIL_MAX_LENGTH = 500;

interface ReleaseStep {
  /** The key in release_step_state: `infra/sql/10-partitions.sql`. */
  step: string;
  group: StepGroup;
  path: string;
}

/** The .sql files of each group under `root`, in name order. */
function listReleaseSteps(root: string): ReleaseStep[] {
  return STEP_GROUPS.flatMap((group) => {
    let names: string[];

    try {
      names = readdirSync(join(root, group));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }

    return names
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({
        step: `${group}/${name}`,
        group,
        path: join(root, group, name),
      }));
  });
}

/** The last status NOTICE of a step, or null when it said none. */
function stepStatus(
  notices: string[],
): { status: StepStatus; detail: string } | null {
  for (let i = notices.length - 1; i >= 0; i -= 1) {
    const match = /^(applied|skipped|pending):\s*([\s\S]*)$/.exec(
      notices[i].trim(),
    );

    if (match) {
      return { status: match[1] as StepStatus, detail: match[2].trim() };
    }
  }

  return null;
}

interface RunnerLog {
  info(message: string): void;
  warn(message: string): void;
}

interface RunnerOptions {
  log: RunnerLog;
  /** POST_DEPLOY_STEPS=off: prisma/post-deploy is left as it is. */
  postDeploy: boolean;
}

interface StepOutcome {
  step: string;
  status: StepStatus;
  detail: string;
}

interface RunOutcome {
  steps: StepOutcome[];
  pending: string[];
}

class StepFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length > DETAIL_MAX_LENGTH
    ? `${flat.slice(0, DETAIL_MAX_LENGTH - 1)}…`
    : flat;
}

async function record(
  client: pg.Client,
  step: string,
  status: StepStatus | "failed",
  detail: string,
): Promise<void> {
  await client.query(
    `INSERT INTO release_step_state (step, status, detail, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (step) DO UPDATE
       SET status = EXCLUDED.status,
           detail = EXCLUDED.detail,
           updated_at = EXCLUDED.updated_at`,
    [step, status, shorten(detail)],
  );
}

/** The session as each step starts it: own role, no statement ceiling. */
async function resetSession(client: pg.Client): Promise<void> {
  await client.query(
    `RESET ROLE; SET statement_timeout = 0; SET lock_timeout = '${STEP_LOCK_TIMEOUT}'`,
  );
}

/**
 * Runs `steps` on `client` and keeps each outcome in release_step_state.
 * Throws StepFailure on the first step that fails (an SQL error, or no
 * status NOTICE), after recording it: the release step stops there.
 */
async function runReleaseSteps(
  client: pg.Client,
  steps: ReleaseStep[],
  options: RunnerOptions,
): Promise<RunOutcome> {
  const { log } = options;
  const outcome: RunOutcome = { steps: [], pending: [] };
  const groups = STEP_GROUPS.filter(
    (group) => options.postDeploy || group !== "prisma/post-deploy",
  );

  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('release_step_state') IS NOT NULL AS present",
  );

  if (!rows[0]?.present) {
    throw new StepFailure(
      RUN_ROW,
      "a tabela release_step_state não existe: os passos rodam depois do prisma migrate deploy.",
    );
  }

  if (!options.postDeploy) {
    log.warn(
      "POST_DEPLOY_STEPS=off: prisma/post-deploy pulado (o estado de cada passo fica como estava). Tire a variável depois da emergência.",
    );
  }

  for (const step of steps) {
    if (!groups.includes(step.group)) continue;

    const notices: string[] = [];
    const onNotice = (notice: { message?: string }) =>
      notices.push(notice.message ?? "");
    const startedAt = Date.now();

    await resetSession(client);
    client.on("notice", onNotice);

    let failure: string | null = null;

    try {
      await client.query(readFileSync(step.path, "utf8"));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      client.off("notice", onNotice);
    }

    if (failure !== null) {
      // An explicit BEGIN in the file leaves the session in an aborted
      // transaction; outside one this is a harmless warning.
      await client.query("ROLLBACK").catch(() => undefined);
      await resetSession(client);
      await record(client, step.step, "failed", failure);
      await record(client, RUN_ROW, "failed", `${step.step}: ${failure}`);

      throw new StepFailure(step.step, `${step.step}: ${failure}`);
    }

    const status = stepStatus(notices);

    await resetSession(client);

    if (!status) {
      const message = `${step.step} terminou sem RAISE NOTICE 'applied: …', 'skipped: …' ou 'pending: …': o passo precisa dizer o que fez.`;

      await record(client, step.step, "failed", message);
      await record(client, RUN_ROW, "failed", message);

      throw new StepFailure(step.step, message);
    }

    await record(client, step.step, status.status, status.detail);
    outcome.steps.push({ step: step.step, ...status });

    if (status.status === "pending") outcome.pending.push(step.step);

    const line = `${step.step}: ${status.status}${status.detail ? ` (${status.detail})` : ""} em ${((Date.now() - startedAt) / 1000).toFixed(1)} s`;

    if (status.status === "pending") log.warn(line);
    else log.info(line);
  }

  // A file that left the repository says nothing any more: its last state
  // must not keep a deploy running the step (a 'pending' forever).
  for (const group of groups) {
    const present = steps
      .filter((step) => step.group === group)
      .map((step) => step.step);

    await client.query(
      `UPDATE release_step_state
          SET status = 'retired', detail = 'o arquivo saiu do repositório', updated_at = now()
        WHERE starts_with(step, $1) AND NOT (step = ANY($2::text[])) AND status <> 'retired'`,
      [`${group}/`, present],
    );
  }

  const count = (status: StepStatus) =>
    outcome.steps.filter((step) => step.status === status).length;

  const summary = [
    `${count("applied")} aplicados, ${count("skipped")} já feitos, ${count("pending")} pendentes`,
    outcome.pending.length > 0
      ? `pendentes: ${outcome.pending.join(", ")}`
      : "",
    options.postDeploy
      ? ""
      : "prisma/post-deploy desligado (POST_DEPLOY_STEPS=off)",
  ]
    .filter(Boolean)
    .join("; ");

  await record(client, RUN_ROW, "applied", summary);
  log.info(`concluído: ${summary}.`);

  return outcome;
}

/** POST_DEPLOY_STEPS: anything but `off` runs prisma/post-deploy. */
function postDeployEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.POST_DEPLOY_STEPS?.trim().toLowerCase() !== "off";
}

export {
  listReleaseSteps,
  postDeployEnabled,
  RUN_ROW,
  runReleaseSteps,
  STEP_GROUPS,
  StepFailure,
  stepStatus,
  type ReleaseStep,
  type RunOutcome,
};
