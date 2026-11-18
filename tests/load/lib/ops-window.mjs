import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The replicas' own numbers over a scene's window (plano-escala LOAD-04),
 * read from their ops_sample rows: the event-loop lag p99 and the RSS of
 * each minute, as each process measured itself (runtime-metrics.ts).
 *
 * k6 sees a request's latency, never the loop of the replica that served
 * it, nor its memory; the plan's acceptances for the import are those two:
 * the api's lag p99 under 100 ms while a spreadsheet of 20 000 lines runs,
 * and its peak RSS within the container's ceiling (the memory budget the
 * process read from its cgroup, `memory_budget.limit_mb`, U-15; or
 * `--rss-limit-mb` when the rows carry none). The import-20k scene prints
 * the window at its end.
 *
 *   node tests/load/lib/ops-window.mjs --since <iso> --until <iso> \
 *     [--roles api,all] [--lag-p99-ms 100] [--rss-limit-mb 1024]
 *
 * DATABASE_URL is the harness' load_test; the query only reads. Prints the
 * verdict as JSON and exits 1 when it fails.
 */

const DEFAULTS = { lagP99Ms: 100, roles: ["api", "all"], rssLimitMb: null };

function numberOr(value, fallback = null) {
  const parsed = Number(value);

  return value !== null && value !== undefined && Number.isFinite(parsed)
    ? parsed
    : fallback;
}

/**
 * Each replica's worst minute: the lag p99 and the RSS. Passes when every
 * replica stayed under the lag and under its ceiling, and the window held
 * at least one row (none is the series switched off, or the wrong window,
 * never a pass).
 */
function opsWindowVerdict(rows, options = {}) {
  const lagP99Ms = options.lagP99Ms ?? DEFAULTS.lagP99Ms;
  const fallbackLimit = options.rssLimitMb ?? DEFAULTS.rssLimitMb;
  const replicas = new Map();

  for (const row of rows) {
    const entry = replicas.get(row.replica) ?? {
      replica: row.replica,
      role: row.role,
      minutes: 0,
      maxLagP99Ms: null,
      maxRssMb: null,
      limitMb: null,
    };

    const lag = numberOr(row.lag_p99_ms);
    const rss = numberOr(row.rss_mb);
    const limit = numberOr(row.limit_mb);

    entry.minutes += 1;
    if (lag !== null) entry.maxLagP99Ms = Math.max(entry.maxLagP99Ms ?? 0, lag);
    if (rss !== null) entry.maxRssMb = Math.max(entry.maxRssMb ?? 0, rss);
    if (limit !== null && limit > 0) entry.limitMb = limit;

    replicas.set(row.replica, entry);
  }

  const reasons = [];
  const judged = [...replicas.values()].map((entry) => ({
    ...entry,
    limitMb: entry.limitMb ?? fallbackLimit,
  }));

  if (judged.length === 0) {
    reasons.push(
      "nenhuma linha de ops_sample na janela (OPS_SAMPLE_ENABLED desligado, ou a janela errada)",
    );
  }

  for (const entry of judged) {
    if (entry.maxLagP99Ms === null) {
      reasons.push(`${entry.replica}: sem medida do event loop`);
    } else if (entry.maxLagP99Ms >= lagP99Ms) {
      reasons.push(
        `${entry.replica}: lag p99 de ${entry.maxLagP99Ms} ms (limite ${lagP99Ms} ms)`,
      );
    }

    if (entry.limitMb === null) {
      reasons.push(
        `${entry.replica}: teto de memória desconhecido (passe --rss-limit-mb)`,
      );
    } else if (entry.maxRssMb === null || entry.maxRssMb >= entry.limitMb) {
      reasons.push(
        `${entry.replica}: RSS de pico ${entry.maxRssMb ?? "?"} MiB para um teto de ${entry.limitMb} MiB`,
      );
    }
  }

  return { pass: reasons.length === 0, lagP99Ms, replicas: judged, reasons };
}

/** `--name value` pairs; the flags this CLI knows. */
function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, "");

    if (name) args[name] = argv[i + 1];
  }

  return args;
}

async function readWindow(url, { since, until, roles }) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });

  await client.connect();

  try {
    // ts is a timestamp in UTC without a zone, as Prisma writes it; the
    // window is compared in the same terms. A minute's row lands after
    // the minute ends, so the window's last minute is read too.
    const { rows } = await client.query(
      `
      SELECT "replica", "role",
             ("metrics" -> 'event_loop' ->> 'lag_p99_ms')::float AS lag_p99_ms,
             ("metrics" -> 'memory' ->> 'rss_mb')::float AS rss_mb,
             ("metrics" -> 'memory_budget' ->> 'limit_mb')::float AS limit_mb
      FROM "ops_sample"
      WHERE "ts" >= ($1::timestamptz AT TIME ZONE 'UTC')
        AND "ts" <= ($2::timestamptz AT TIME ZONE 'UTC') + interval '75 seconds'
        AND "role" = ANY($3::text[])
      ORDER BY "replica", "ts"
      `,
      [since, until, roles],
    );

    return rows;
  } finally {
    await client.end();
  }
}

export { DEFAULTS, opsWindowVerdict, parseArgs };

const invokedDirectly =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));

  if (!args.since || !args.until || !process.env.DATABASE_URL) {
    console.error(
      "uso: DATABASE_URL=<load_test> node tests/load/lib/ops-window.mjs --since <iso> --until <iso> [--roles api,all] [--lag-p99-ms 100] [--rss-limit-mb 1024]",
    );
    process.exit(2);
  }

  const rows = await readWindow(process.env.DATABASE_URL, {
    since: args.since,
    until: args.until,
    roles: (args.roles ?? DEFAULTS.roles.join(",")).split(","),
  });

  const verdict = opsWindowVerdict(rows, {
    lagP99Ms: numberOr(args["lag-p99-ms"], DEFAULTS.lagP99Ms),
    rssLimitMb: numberOr(args["rss-limit-mb"], DEFAULTS.rssLimitMb),
  });

  console.log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.pass ? 0 : 1);
}
