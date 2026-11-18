import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { openReleaseClient } from "infra/scripts/release-connection";
import { HISTORY_WINDOW_SETTING } from "infra/scripts/release-step-runner";

import { runPostDeployStep } from "./post-deploy-step";

/**
 * The copy windows of the history (plano-escala F2-17, F2-18) on this E2E
 * file's database.
 *
 * Every E2E database is a clone of a template the release step ran on with
 * no HISTORY_WINDOW_APPROVED, so delivery_event and activity are the plain
 * tables production has until its window, next to their empty shells. A
 * file about the window approves it here, on its own database only, the
 * way release-steps.ts hands the Environment's interval to the files.
 */

/** An approval covering now: a minute back to an hour ahead. */
function approvedNow(now: Date = new Date()): Record<string, string> {
  const from = new Date(now.getTime() - 60_000).toISOString();
  const to = new Date(now.getTime() + 3_600_000).toISOString();

  return { [HISTORY_WINDOW_SETTING]: `${from}/${to}` };
}

/** An approval that ended an hour ago: the window must not run. */
function approvedEarlier(now: Date = new Date()): Record<string, string> {
  const from = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  const to = new Date(now.getTime() - 3_600_000).toISOString();

  return { [HISTORY_WINDOW_SETTING]: `${from}/${to}` };
}

type HistoryWindowStep =
  "30-delivery-event-window.sql" | "31-activity-window.sql";

/** One window step, by the release step's runner, with `settings`. */
function runHistoryWindow(
  step: HistoryWindowStep,
  settings: Readonly<Record<string, string>> = approvedNow(),
): Promise<{ status: string; detail: string }> {
  return runPostDeployStep(step, "e2e-history-window", settings);
}

/**
 * The way back the owner would run by hand, in its 14 days: the
 * partitioned table becomes the empty shell again and the legacy table
 * takes its name back (prisma/post-deploy/rollback/unpartition-*.sql).
 * The script leaves the comment 'trajetto:window-hold' on the table, which
 * keeps the window away; `hold: false` takes it off, so a later run of the
 * window finds a plain table to copy. Returns the script's NOTICE.
 */
async function unpartitionHistory(
  table: "delivery_event" | "activity",
  { hold = true }: { hold?: boolean } = {},
): Promise<string> {
  const client = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "e2e-unpartition-history",
  );
  const notices: string[] = [];

  client.on("notice", (notice) => notices.push(notice.message ?? ""));

  try {
    await client.query(
      "SELECT set_config('trajetto.unpartition_history', $1, false)",
      [table],
    );
    await client.query(
      readFileSync(
        resolve(
          process.cwd(),
          "prisma",
          "post-deploy",
          "rollback",
          `unpartition-${table.replace("_", "-")}.sql`,
        ),
        "utf8",
      ),
    );

    if (!hold) await client.query(`COMMENT ON TABLE "${table}" IS NULL`);

    return notices.join("\n");
  } finally {
    await client.end();
  }
}

/**
 * The rehearsal block of docs/runbooks/history-window.md ("Antes", step 1),
 * replayed the way psql runs it: one session, each `\i <file>` the file's
 * text, every other statement up to the `;` that ends its line, comment
 * lines skipped. Returns the NOTICE lines each `\i` printed, by file.
 *
 * The owner types this block on a disposable database seeded with
 * prod-like, with no process of the API at all (D70); a block that cannot
 * reach 'applied' there leaves the gate of wave 11 (the write pause under
 * 60 s) with nothing to measure.
 */
async function replayRunbookRehearsal(): Promise<Record<string, string>> {
  const runbook = readFileSync(
    resolve(process.cwd(), "docs", "runbooks", "history-window.md"),
    "utf8",
  );
  const block =
    /```sql\n((?:(?!```)[\s\S])*\\i prisma\/post-deploy\/30-delivery-event-window\.sql(?:(?!```)[\s\S])*)```/.exec(
      runbook,
    )?.[1];

  if (!block) {
    throw new Error(
      "o runbook history-window.md não tem o bloco do ensaio (\\i prisma/post-deploy/30-delivery-event-window.sql)",
    );
  }

  const client = await openReleaseClient(
    process.env.DATABASE_URL as string,
    "psql",
  );
  const notices: Record<string, string> = {};
  let printed: string[] = [];

  client.on("notice", (notice) => printed.push(notice.message ?? ""));

  try {
    let statement = "";

    for (const raw of block.split("\n")) {
      const line = raw.trim();

      if (statement === "" && (line === "" || line.startsWith("--"))) continue;

      const include = /^\\i\s+(\S+)$/.exec(line);

      if (include) {
        printed = [];
        await client.query(
          readFileSync(resolve(process.cwd(), include[1]), "utf8"),
        );
        notices[include[1]] = printed.join("\n");
        continue;
      }

      statement += `${line}\n`;

      if (line.endsWith(";")) {
        await client.query(statement);
        statement = "";
      }
    }

    if (statement.trim() !== "") {
      throw new Error(`instrução sem ';' no bloco do runbook: ${statement}`);
    }

    return notices;
  } finally {
    await client.end();
  }
}

export {
  approvedEarlier,
  approvedNow,
  replayRunbookRehearsal,
  runHistoryWindow,
  unpartitionHistory,
  type HistoryWindowStep,
};
