import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@prisma/client";
import { createPrismaClient } from "@/shared/database/database-client";
import { readCronJobs } from "@/shared/health/operational-state";

/**
 * The cron state on /health/metrics and in the ops heartbeat (readCronJobs),
 * read once a minute.
 *
 * On staging (26/11/2026) scheduled_job_execution held ~144 000 rows, 30
 * days of the per-minute jobs, and the statement sorted all of them every
 * minute to keep the newest row of ~20 jobs: a DISTINCT ON over the table
 * that spilled ~3 MB to disk twice per run under work_mem 4MB, 3.6 s once on
 * a cold cache. The rewrite walks the indexes per job name instead.
 *
 * The semantic tests pin what the rewrite had to keep, and pass on both
 * statements: the newest run per job, the last success by finishedAt with
 * NULLs skipped, the stale RUNNING count, a removed job still listed, and
 * the partial streak (a NULL lastError or a statement timeout breaks it).
 * The plan test is the one that failed before: no Sort and no Seq Scan on
 * the table.
 */
const prisma = createPrismaClient();

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const PARTIAL = "[partial] parou no orçamento ou no teto com sobra em: x";
const TIMEOUT = "canceling statement due to statement timeout";

/** The current minute: every seeded instant is a whole minute before it. */
const minute = new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS);
const ago = (ms: number) => new Date(minute.getTime() - ms);
/** When a run seeded `ms` before the minute finished, as `run` writes it. */
const finishedIso = (ms: number) =>
  new Date(ago(ms).getTime() + 2_000).toISOString();

const REGISTERED = [
  "vol-every-minute",
  "vol-every-five",
  "latest-newest",
  "success-null-finish",
  "success-never-finished",
  "stale-counted",
  "partial-only",
  "partial-after-timeout",
  "partial-after-null",
  "partial-never-succeeded",
  "partial-before-success",
  "partial-running-between",
  "registered-never-ran",
].map((name) => ({ name, schedule: "0 3 * * *" }));

async function run(
  jobName: string,
  scheduledFor: Date,
  status: "RUNNING" | "SUCCEEDED" | "FAILED",
  extra: {
    lastError?: string | null;
    finishedAt?: Date | null;
    leaseExpiresAt?: Date;
    attempts?: number;
  } = {},
) {
  await prisma.scheduledJobExecution.create({
    data: {
      jobName,
      scheduledFor,
      status,
      attempts: extra.attempts ?? 1,
      leaseExpiresAt:
        extra.leaseExpiresAt ?? new Date(scheduledFor.getTime() + 10_000),
      finishedAt:
        extra.finishedAt !== undefined
          ? extra.finishedAt
          : status === "RUNNING"
            ? null
            : new Date(scheduledFor.getTime() + 2_000),
      lastError: extra.lastError ?? null,
    },
  });
}

async function readJob(name: string) {
  const jobs = await readCronJobs(REGISTERED);

  return jobs.find((job) => job.job === name);
}

beforeAll(async () => {
  // Volume: 30 days of a per-minute job and of a five-minute one, ~52 000
  // rows, enough for the planner to prefer the table scan and the sort the
  // old statement asked for. The series ends at the same `minute` the
  // assertions use, read once from the Node clock: the database's now()
  // could sit on the other side of a minute boundary (or of a clock drift
  // between host and container) and make the newest row one minute off.
  // The columns are timestamp(3) holding UTC, hence the ISO text without
  // its "Z".
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "scheduled_job_execution"
      ("id", "jobName", "scheduledFor", "status", "attempts", "leaseExpiresAt",
       "startedAt", "finishedAt", "created_at", "updated_at")
    SELECT gen_random_uuid()::text, j.name, t, 'SUCCEEDED', 1,
      t + interval '10 minutes', t, t + interval '2 seconds', t, t
    FROM (VALUES ('vol-every-minute', interval '1 minute'),
                 ('vol-every-five', interval '5 minutes')) AS j(name, step)
    CROSS JOIN LATERAL generate_series(
      $1::timestamp - interval '30 days',
      $1::timestamp - interval '1 minute',
      j.step) AS t
  `,
    minute.toISOString().slice(0, -1),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the cron state (readCronJobs)", () => {
  it("reports the newest run of each job, however many runs it has", async () => {
    const longError = `${TIMEOUT} ${"x".repeat(800)}`;

    await run("latest-newest", ago(3 * DAY_MS), "SUCCEEDED");
    await run("latest-newest", ago(2 * DAY_MS), "FAILED", {
      lastError: longError,
      attempts: 3,
    });
    // Inserted last but older: the newest slot wins, not the newest row.
    await run("latest-newest", ago(4 * DAY_MS), "SUCCEEDED");

    const job = await readJob("latest-newest");

    expect(job).toMatchObject({
      schedule: "0 3 * * *",
      last_status: "FAILED",
      last_scheduled_for: ago(2 * DAY_MS).toISOString(),
      last_finished_at: finishedIso(2 * DAY_MS),
      last_succeeded_at: finishedIso(3 * DAY_MS),
      attempts: 3,
      last_error: longError.slice(0, 500),
      stale_running: 0,
      last_partial: false,
      partial_since: null,
    });

    const volume = await readJob("vol-every-minute");

    expect(volume).toMatchObject({
      last_status: "SUCCEEDED",
      last_scheduled_for: ago(MINUTE_MS).toISOString(),
      last_succeeded_at: finishedIso(MINUTE_MS),
    });
  });

  it("dates the last success by the latest finish, skipping successes that never finished", async () => {
    // The newest success has no finishedAt (max() skips NULLs); an older one
    // finished later than the slot after it.
    await run("success-null-finish", ago(1 * DAY_MS), "SUCCEEDED", {
      finishedAt: null,
    });
    await run("success-null-finish", ago(2 * DAY_MS), "SUCCEEDED", {
      finishedAt: ago(1 * DAY_MS + HOUR_MS),
    });
    await run("success-null-finish", ago(3 * DAY_MS), "SUCCEEDED");

    // Successes only with no finishedAt: no last success at all.
    await run("success-never-finished", ago(DAY_MS), "SUCCEEDED", {
      finishedAt: null,
    });

    expect(await readJob("success-null-finish")).toMatchObject({
      last_status: "SUCCEEDED",
      last_finished_at: null,
      last_succeeded_at: ago(1 * DAY_MS + HOUR_MS).toISOString(),
    });
    expect(await readJob("success-never-finished")).toMatchObject({
      last_status: "SUCCEEDED",
      last_succeeded_at: null,
    });
  });

  it("counts every RUNNING run whose lease ran out, and not the live one", async () => {
    await run("stale-counted", ago(3 * DAY_MS), "RUNNING", {
      leaseExpiresAt: ago(3 * DAY_MS - 10 * MINUTE_MS),
    });
    await run("stale-counted", ago(2 * DAY_MS), "RUNNING", {
      leaseExpiresAt: ago(2 * DAY_MS - 10 * MINUTE_MS),
    });
    await run("stale-counted", ago(DAY_MS), "SUCCEEDED");
    await run("stale-counted", ago(0), "RUNNING", {
      leaseExpiresAt: new Date(Date.now() + HOUR_MS),
    });

    expect(await readJob("stale-counted")).toMatchObject({
      last_status: "RUNNING",
      last_finished_at: null,
      stale_running: 2,
      last_succeeded_at: finishedIso(DAY_MS),
    });
  });

  it("lists a removed job with a null schedule and a job that never ran with nulls", async () => {
    await run("retired-job", ago(5 * DAY_MS), "SUCCEEDED");
    await run("retired-job", ago(4 * DAY_MS), "RUNNING", {
      leaseExpiresAt: ago(4 * DAY_MS - 10 * MINUTE_MS),
    });

    const jobs = await readCronJobs(REGISTERED);
    const names = jobs.map((job) => job.job);

    expect(names).toEqual([...names].sort());
    expect(jobs.find((job) => job.job === "retired-job")).toMatchObject({
      schedule: null,
      last_status: "RUNNING",
      stale_running: 1,
    });
    expect(
      jobs.find((job) => job.job === "registered-never-ran"),
    ).toStrictEqual({
      job: "registered-never-ran",
      schedule: "0 3 * * *",
      last_status: null,
      last_scheduled_for: null,
      last_finished_at: null,
      last_succeeded_at: null,
      attempts: null,
      last_error: null,
      stale_running: 0,
      last_partial: false,
      partial_since: null,
    });

    // With no registry the rows still list every job that ran.
    const unscheduled = await readCronJobs([]);

    expect(unscheduled.map((job) => job.job)).toContain("retired-job");
    expect(unscheduled.map((job) => job.job)).not.toContain(
      "registered-never-ran",
    );
  });

  it("dates a partial streak from its first partial, and only while nothing else failed since the last success", async () => {
    // Nothing but partials since the success: dated from the first one.
    await run("partial-only", ago(30 * HOUR_MS), "SUCCEEDED");
    await run("partial-only", ago(20 * HOUR_MS), "FAILED", {
      lastError: PARTIAL,
    });
    await run("partial-only", ago(2 * HOUR_MS), "FAILED", {
      lastError: PARTIAL,
    });

    // A statement timeout after the success: not "only slow".
    await run("partial-after-timeout", ago(72 * HOUR_MS), "SUCCEEDED");
    await run("partial-after-timeout", ago(48 * HOUR_MS), "FAILED", {
      lastError: TIMEOUT,
    });
    await run("partial-after-timeout", ago(2 * HOUR_MS), "FAILED", {
      lastError: PARTIAL,
    });

    // A failure with no message counts as a real one.
    await run("partial-after-null", ago(10 * HOUR_MS), "SUCCEEDED");
    await run("partial-after-null", ago(5 * HOUR_MS), "FAILED");
    await run("partial-after-null", ago(2 * HOUR_MS), "FAILED", {
      lastError: PARTIAL,
    });

    // Never succeeded: the streak runs from the first partial ever.
    await run("partial-never-succeeded", ago(9 * HOUR_MS), "FAILED", {
      lastError: PARTIAL,
    });
    await run("partial-never-succeeded", ago(2 * HOUR_MS), "FAILED", {
      lastError: PARTIAL,
    });

    // A real failure before the last success does not count.
    await run("partial-before-success", ago(30 * HOUR_MS), "FAILED");
    await run("partial-before-success", ago(20 * HOUR_MS), "SUCCEEDED");
    await run("partial-before-success", ago(2 * HOUR_MS), "FAILED", {
      lastError: PARTIAL,
    });

    // A run left RUNNING inside the streak neither breaks nor starts it.
    await run("partial-running-between", ago(30 * HOUR_MS), "SUCCEEDED");
    await run("partial-running-between", ago(20 * HOUR_MS), "FAILED", {
      lastError: PARTIAL,
    });
    await run("partial-running-between", ago(10 * HOUR_MS), "RUNNING", {
      leaseExpiresAt: ago(10 * HOUR_MS - 10 * MINUTE_MS),
    });
    await run("partial-running-between", ago(2 * HOUR_MS), "FAILED", {
      lastError: PARTIAL,
    });

    const jobs = new Map(
      (await readCronJobs(REGISTERED)).map((job) => [job.job, job]),
    );

    expect(jobs.get("partial-only")).toMatchObject({
      last_partial: true,
      partial_since: ago(20 * HOUR_MS).toISOString(),
    });
    expect(jobs.get("partial-after-timeout")).toMatchObject({
      last_partial: true,
      partial_since: null,
    });
    expect(jobs.get("partial-after-null")).toMatchObject({
      last_partial: true,
      partial_since: null,
    });
    expect(jobs.get("partial-never-succeeded")).toMatchObject({
      last_partial: true,
      partial_since: ago(9 * HOUR_MS).toISOString(),
      last_succeeded_at: null,
    });
    expect(jobs.get("partial-before-success")).toMatchObject({
      last_partial: true,
      partial_since: ago(2 * HOUR_MS).toISOString(),
    });
    expect(jobs.get("partial-running-between")).toMatchObject({
      last_partial: true,
      partial_since: ago(20 * HOUR_MS).toISOString(),
      stale_running: 1,
    });
  });

  it("walks the indexes per job instead of sorting the table", async () => {
    let captured: Prisma.Sql | null = null;

    const database = (await import("@/../infra/database")).default;

    // Swapped by assignment, not vi.spyOn: Prisma 7's client is a Proxy whose
    // property descriptors carry no value (ai-pipeline-lease.test.ts).
    const client = database as unknown as { $queryRaw: unknown };
    const ownQueryRaw = client.$queryRaw;

    client.$queryRaw = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      client.$queryRaw = ownQueryRaw;
      captured = Prisma.sql(strings, ...values);
      return [];
    }) as never;

    try {
      await readCronJobs(REGISTERED);
    } finally {
      client.$queryRaw = ownQueryRaw;
    }

    expect(captured).not.toBeNull();

    const statement = captured as unknown as Prisma.Sql;

    await prisma.$executeRawUnsafe(
      `VACUUM (ANALYZE) "scheduled_job_execution"`,
    );

    const rows = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
      `EXPLAIN (FORMAT JSON) ${statement.text}`,
      ...statement.values,
    );
    const raw = rows[0]["QUERY PLAN"];
    const plan = (
      (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
        Plan: PlanNode;
      }>
    )[0].Plan;
    const nodes = flatten(plan);

    expect(
      nodes.filter((node) => /Sort/.test(node["Node Type"])),
      JSON.stringify(plan),
    ).toEqual([]);
    expect(
      nodes.filter(
        (node) =>
          node["Node Type"] === "Seq Scan" &&
          node["Relation Name"] === "scheduled_job_execution",
      ),
      JSON.stringify(plan),
    ).toEqual([]);
  });
});

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}
