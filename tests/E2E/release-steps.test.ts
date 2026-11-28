import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { openReleaseClient } from "infra/scripts/release-connection";
import {
  listReleaseSteps,
  runReleaseSteps,
  StepFailure,
} from "infra/scripts/release-step-runner";

/**
 * The steps after `migrate deploy` against a real Postgres (plano-escala
 * F5-08): infra/sql, then prisma/post-deploy, each file's NOTICE kept in
 * release_step_state — the row a 'pending' step leaves is what makes the
 * next deploy run the release step again (U-11).
 *
 * Marker steps in a scratch root, run as the release step runs them: a
 * table created once ('applied', then 'skipped'), a gate that keeps a
 * post-deploy step 'pending' until it opens, a step that says nothing, one
 * that errors. And the E2E template itself: every file's database starts
 * as a release leaves it, with the run recorded.
 */
const URL = () => process.env.DATABASE_URL as string;

let admin: pg.Client;
let root: string;
const lines: string[] = [];

const log = {
  info: (message: string) => lines.push(`info ${message}`),
  warn: (message: string) => lines.push(`warn ${message}`),
};

function step(path: string, sql: string) {
  const file = join(root, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sql);
}

const MARKER = `
DO $$
BEGIN
  IF to_regclass('release_marker') IS NULL THEN
    CREATE TABLE release_marker (id int);
    RAISE NOTICE 'applied: marcador criado';
  ELSE
    RAISE NOTICE 'skipped: marcador já existe';
  END IF;
END $$;`;

const GATED = `
DO $$
BEGIN
  IF to_regclass('release_gate') IS NULL THEN
    RAISE NOTICE 'pending: esperando o portão';
  ELSE
    RAISE NOTICE 'applied: portão aberto';
  END IF;
END $$;`;

async function steps(postDeploy = true) {
  const client = await openReleaseClient(URL(), "e2e-release-steps");

  try {
    return await runReleaseSteps(client, listReleaseSteps(root), {
      log,
      postDeploy,
    });
  } finally {
    await client.end();
  }
}

async function rows(): Promise<
  Record<string, { status: string; detail: string | null }>
> {
  const { rows } = await admin.query<{
    step: string;
    status: string;
    detail: string | null;
  }>("SELECT step, status, detail FROM release_step_state ORDER BY step");

  return Object.fromEntries(
    rows.map((row) => [row.step, { status: row.status, detail: row.detail }]),
  );
}

let templateRun: { status: string; detail: string | null } | undefined;

beforeAll(async () => {
  admin = await openReleaseClient(URL(), "e2e-release-admin");
  // Read before any test writes: what the clone brought from the template.
  templateRun = (await rows())["@release"];
});

afterAll(async () => {
  await admin.end();
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "trajetto-release-steps-"));
  lines.length = 0;
  await admin.query(
    "DELETE FROM release_step_state; DROP TABLE IF EXISTS release_marker; DROP TABLE IF EXISTS release_gate",
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the steps after the migrations", () => {
  it("are already applied in the E2E template every file is cloned from", () => {
    expect(templateRun).toEqual({
      status: "applied",
      detail: expect.stringContaining("aplicados"),
    });
  });

  it("run infra/sql, then prisma/post-deploy, and keep what each one said", async () => {
    step("infra/sql/10-marker.sql", MARKER);
    step("prisma/post-deploy/10-gated.sql", GATED);

    const outcome = await steps();

    expect(outcome.steps.map((each) => each.step)).toEqual([
      "infra/sql/10-marker.sql",
      "prisma/post-deploy/10-gated.sql",
    ]);
    expect(outcome.pending).toEqual(["prisma/post-deploy/10-gated.sql"]);
    expect(await rows()).toEqual({
      "@release": {
        status: "applied",
        detail:
          "1 aplicados, 0 já feitos, 1 pendentes; pendentes: prisma/post-deploy/10-gated.sql",
      },
      "infra/sql/10-marker.sql": {
        status: "applied",
        detail: "marcador criado",
      },
      "prisma/post-deploy/10-gated.sql": {
        status: "pending",
        detail: "esperando o portão",
      },
    });
  });

  it("say 'skipped' on the second run, and apply a pending step once its state arrives", async () => {
    step("infra/sql/10-marker.sql", MARKER);
    step("prisma/post-deploy/10-gated.sql", GATED);

    await steps();
    await admin.query("CREATE TABLE release_gate (id int)");

    const second = await steps();

    expect(second.pending).toEqual([]);
    expect(await rows()).toMatchObject({
      "infra/sql/10-marker.sql": { status: "skipped" },
      "prisma/post-deploy/10-gated.sql": {
        status: "applied",
        detail: "portão aberto",
      },
    });
  });

  it("fail on a step that does not say what it did, and run nothing after it", async () => {
    step("infra/sql/10-silent.sql", "SELECT 1;");
    step("prisma/post-deploy/10-gated.sql", GATED);

    await expect(steps()).rejects.toBeInstanceOf(StepFailure);

    const state = await rows();

    expect(state["infra/sql/10-silent.sql"].status).toBe("failed");
    expect(state["@release"].status).toBe("failed");
    expect(state["prisma/post-deploy/10-gated.sql"]).toBeUndefined();
  });

  it("record an SQL error as failed, even from inside an explicit transaction", async () => {
    step(
      "infra/sql/10-broken.sql",
      "BEGIN; SELECT 1 / 0; COMMIT; DO $$ BEGIN RAISE NOTICE 'applied: x'; END $$;",
    );

    await expect(steps()).rejects.toThrow(/division by zero/);

    const state = await rows();

    expect(state["infra/sql/10-broken.sql"]).toEqual({
      status: "failed",
      detail: expect.stringContaining("division by zero"),
    });
  });

  it("put the session back between steps: a SET never leaks into the next one", async () => {
    step(
      "infra/sql/10-short.sql",
      "SET lock_timeout = '1ms'; DO $$ BEGIN RAISE NOTICE 'applied: curto'; END $$;",
    );
    step(
      "infra/sql/20-reads.sql",
      "DO $$ BEGIN RAISE NOTICE 'applied: lock_timeout=%', current_setting('lock_timeout'); END $$;",
    );

    await steps();

    expect((await rows())["infra/sql/20-reads.sql"].detail).toBe(
      "lock_timeout=5s",
    );
  });

  it("leave prisma/post-deploy as it was with POST_DEPLOY_STEPS=off, and say so", async () => {
    step("infra/sql/10-marker.sql", MARKER);
    step("prisma/post-deploy/10-gated.sql", GATED);

    await steps();
    await admin.query("CREATE TABLE release_gate (id int)");
    await steps(false);

    const state = await rows();

    expect(state["prisma/post-deploy/10-gated.sql"].status).toBe("pending");
    expect(state["@release"].detail).toContain("POST_DEPLOY_STEPS=off");
    expect(
      lines.some((line) => line.startsWith("warn POST_DEPLOY_STEPS=off")),
    ).toBe(true);
  });

  it("retire the state of a file that left the repository, so it stops forcing a run", async () => {
    step("infra/sql/10-marker.sql", MARKER);
    step("prisma/post-deploy/10-gated.sql", GATED);

    await steps();
    unlinkSync(join(root, "prisma/post-deploy/10-gated.sql"));

    const second = await steps();

    expect(second.pending).toEqual([]);
    expect((await rows())["prisma/post-deploy/10-gated.sql"]).toEqual({
      status: "retired",
      detail: "o arquivo saiu do repositório",
    });
  });
});
