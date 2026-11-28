import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "prometheus" });

/**
 * `/metrics` in the Prometheus text format, on a port of its own
 * (plano-escala F5-29), for the vmagent of the metrics stack (F5-30).
 *
 * Off unless METRICS_PORT is set. Then a second, tiny HTTP server listens
 * on that port, outside Fastify and outside every Domain of the Dokploy:
 * only the swarm's network reaches it, and the scraper finds each replica
 * by `tasks.<App Name>`. That network is shared by staging and production
 * (the two environments run on the same Dokploy), so the port is never
 * open: every scrape carries `Authorization: Bearer <METRICS_TOKEN>`, and
 * the boot refuses a METRICS_PORT without a token of 32 characters or
 * more. Anything else answers 401 (or 404 off /metrics), with no body
 * that says why.
 *
 * Only infrastructure numbers: the process, its event loop, its HTTP
 * traffic by route group, its database pool, its sockets, and the alerts
 * the ops heartbeat judged (by code). Never a label of a company, a
 * person, a device or an address: a label name outside METRIC_LABELS, or a
 * value that looks like an id, an e-mail, an IP or a document number, is
 * refused at render and counted in `trajetto_metrics_refused_series`, so a
 * future metric cannot leak a tenant into the time series by accident.
 */

type MetricType = "gauge" | "counter" | "histogram";

interface MetricSample {
  labels?: Readonly<Record<string, string>>;
  value: number;
  /** A histogram's series: `_bucket` (with `le`), `_sum` and `_count`. */
  suffix?: "_bucket" | "_sum" | "_count";
}

interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: readonly MetricSample[];
}

/** The only label names a series may carry. */
const METRIC_LABELS = [
  "role",
  "app_env",
  "commit",
  "group",
  "class",
  "pool",
  "adapter",
  "code",
  "le",
] as const;

const ALLOWED = new Set<string>(METRIC_LABELS);

const METRIC_NAME = /^trajetto_[a-z][a-z0-9_]*$/;

/** What a label value must never look like: someone's or something's id. */
const FORBIDDEN_VALUES: ReadonlyArray<[string, RegExp]> = [
  ["uuid", /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i],
  ["email", /[^\s@]+@[^\s@]+/],
  ["ip", /\b\d{1,3}(\.\d{1,3}){3}\b|[0-9a-f]{1,4}(:[0-9a-f]{0,4}){3,}/i],
  // CPF, CNPJ, a phone, a document key: eleven digits or more in a row.
  ["digits", /\d{11,}/],
];

/** Why a label may not go out, or null when it may. */
function refusedLabel(name: string, value: string): string | null {
  if (!ALLOWED.has(name)) return `label '${name}' fora da lista`;

  if (value.length > 64) return `valor de '${name}' longo demais`;

  for (const [kind, pattern] of FORBIDDEN_VALUES) {
    if (pattern.test(value)) return `valor de '${name}' parece ${kind}`;
  }

  return null;
}

const escapeHelp = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

const escapeValue = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";

  return String(value);
}

/**
 * The text format (version 0.0.4): HELP and TYPE per family, then one line
 * per series. A family whose name breaks the convention, and a series with
 * a refused label, are left out and counted; the count is its own series.
 */
function renderPrometheus(families: readonly MetricFamily[]): {
  text: string;
  refused: string[];
} {
  const refused: string[] = [];
  const lines: string[] = [];

  for (const family of families) {
    if (!METRIC_NAME.test(family.name)) {
      refused.push(`nome inválido: ${family.name}`);
      continue;
    }

    const series: string[] = [];

    for (const sample of family.samples) {
      const entries = Object.entries(sample.labels ?? {});
      const reason = entries
        .map(([name, value]) => refusedLabel(name, value))
        .find((each) => each !== null);

      if (reason) {
        refused.push(`${family.name}: ${reason}`);
        continue;
      }

      const labels =
        entries.length === 0
          ? ""
          : `{${entries
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([name, value]) => `${name}="${escapeValue(value)}"`)
              .join(",")}}`;

      series.push(
        `${family.name}${sample.suffix ?? ""}${labels} ${formatNumber(sample.value)}`,
      );
    }

    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    lines.push(...series);
  }

  lines.push(
    "# HELP trajetto_metrics_refused_series Séries recusadas por rótulo ou nome nesta leitura.",
    "# TYPE trajetto_metrics_refused_series gauge",
    `trajetto_metrics_refused_series ${refused.length}`,
  );

  return { text: `${lines.join("\n")}\n`, refused };
}

type FamilyReader = () => MetricFamily[] | Promise<MetricFamily[]>;

const readers = new Map<string, FamilyReader>();

/**
 * Adds a source of families, by a fixed name (one registration per name,
 * the last wins). Read on every scrape: a reader must be cheap and in
 * memory; a database read does not belong in a scrape.
 */
function registerPrometheusFamilies(name: string, read: FamilyReader): void {
  readers.set(name, read);
}

/**
 * Every registered source, each on its own (one that throws is skipped),
 * then the alerts.
 */
async function collectPrometheus(): Promise<MetricFamily[]> {
  const families: MetricFamily[] = [];

  for (const [name, read] of readers) {
    try {
      families.push(...(await read()));
    } catch (error) {
      log.warn({ err: error, source: name }, "a metrics source failed");
    }
  }

  return [...families, ...alertFamilies()];
}

/** The alerts the ops heartbeat judged last, in the process that ran it. */
let alertVerdict: { codes: ReadonlySet<string>; at: number } | null = null;

/**
 * What the ops heartbeat judged this minute (src/jobs/cron/ops-heartbeat-job.ts):
 * exposed as `trajetto_alert_active{code}` for every known code, so the
 * vmalert rules of F5-30 page on the same codes as the healthchecks.io
 * ping. Only the process that won the minute has it.
 */
function recordAlertVerdict(
  known: readonly string[],
  active: readonly string[],
  at: Date = new Date(),
): void {
  alertVerdict = { codes: new Set(active), at: at.getTime() };
  alertCodes = known;
}

let alertCodes: readonly string[] = [];

function alertFamilies(): MetricFamily[] {
  if (!alertVerdict) return [];

  const verdict = alertVerdict;

  return [
    {
      name: "trajetto_alert_active",
      help: "1 quando o heartbeat de operação julgou o alerta ativo no último minuto.",
      type: "gauge",
      samples: alertCodes.map((code) => ({
        labels: { code },
        value: verdict.codes.has(code) ? 1 : 0,
      })),
    },
    {
      name: "trajetto_alert_evaluated_timestamp_seconds",
      help: "Quando o heartbeat de operação julgou os alertas pela última vez.",
      type: "gauge",
      samples: [{ value: Math.floor(verdict.at / 1000) }],
    },
  ];
}

/** The class counts of a group, as the HTTP metrics keep them. */
interface GroupCounts {
  requests: number;
  classes: Readonly<
    Record<"2xx" | "3xx" | "4xx" | "5xx" | "429" | "503", number>
  >;
  latency_ms: { counts: readonly number[]; sum: number };
}

interface ProcessInputs {
  identity: { role: string; appEnv: string; commit: string | null };
  uptimeSeconds: number;
  memory: { rss: number; heapUsed: number };
  eventLoop: { lagP99Ms: number | null; utilization: number };
  /** HTTP_LATENCY_BUCKETS_MS, the upper bounds of the histogram. */
  latencyBucketsMs: readonly number[];
  http: Readonly<Record<string, GroupCounts>>;
  pool: {
    open: number;
    busy: number;
    idle: number;
    waiting: number;
    limit: number | null;
  } | null;
  sockets: { local: number; cap: number; adapter: string } | null;
}

/**
 * The process's own families: who it is, its memory and event loop, its
 * HTTP traffic since it started (by route group, the names of
 * src/shared/health/route-groups.ts, never a path with an id), its
 * database pool and its sockets. Counters since the start: Prometheus
 * turns them into rates and notices a restart.
 */
function processFamilies(input: ProcessInputs): MetricFamily[] {
  const groups = Object.entries(input.http);
  const families: MetricFamily[] = [
    {
      name: "trajetto_build_info",
      help: "O processo: papel, ambiente e commit da imagem (sempre 1).",
      type: "gauge",
      samples: [
        {
          labels: {
            role: input.identity.role,
            app_env: input.identity.appEnv,
            // The short commit: a full sha would read as an id.
            commit: (input.identity.commit ?? "dev").slice(0, 12),
          },
          value: 1,
        },
      ],
    },
    {
      name: "trajetto_process_uptime_seconds",
      help: "Segundos desde que o processo começou.",
      type: "gauge",
      samples: [{ value: Math.round(input.uptimeSeconds) }],
    },
    {
      name: "trajetto_process_resident_memory_bytes",
      help: "Memória residente do processo (rss).",
      type: "gauge",
      samples: [{ value: input.memory.rss }],
    },
    {
      name: "trajetto_process_heap_used_bytes",
      help: "Heap do V8 em uso.",
      type: "gauge",
      samples: [{ value: input.memory.heapUsed }],
    },
    {
      name: "trajetto_event_loop_utilization",
      help: "Parte da janela atual em que o event loop esteve ocupado (0 a 1).",
      type: "gauge",
      samples: [{ value: input.eventLoop.utilization }],
    },
    {
      name: "trajetto_event_loop_lag_p99_seconds",
      help: "Atraso p99 do event loop na janela atual.",
      type: "gauge",
      samples:
        input.eventLoop.lagP99Ms === null
          ? []
          : [{ value: input.eventLoop.lagP99Ms / 1000 }],
    },
    {
      name: "trajetto_http_responses_total",
      help: "Respostas HTTP desde o início do processo, por grupo de rota e classe.",
      type: "counter",
      samples: groups.flatMap(([group, counts]) =>
        (["2xx", "3xx", "4xx", "5xx"] as const).map((each) => ({
          labels: { group, class: each },
          value: counts.classes[each],
        })),
      ),
    },
    {
      name: "trajetto_http_throttled_total",
      help: "Respostas 429 (limitador) desde o início, por grupo; já contadas em 4xx.",
      type: "counter",
      samples: groups.map(([group, counts]) => ({
        labels: { group },
        value: counts.classes["429"],
      })),
    },
    {
      name: "trajetto_http_unavailable_total",
      help: "Respostas 503 (banco ou dependência recusando) desde o início, por grupo; já contadas em 5xx.",
      type: "counter",
      samples: groups.map(([group, counts]) => ({
        labels: { group },
        value: counts.classes["503"],
      })),
    },
    {
      name: "trajetto_http_request_duration_seconds",
      help: "Duração das respostas HTTP desde o início, por grupo de rota.",
      type: "histogram",
      samples: groups.flatMap(([group, counts]) => {
        let cumulative = 0;
        const buckets = input.latencyBucketsMs.map((bound, index) => {
          cumulative += counts.latency_ms.counts[index] ?? 0;

          return {
            labels: { group, le: String(bound / 1000) },
            value: cumulative,
            suffix: "_bucket" as const,
          };
        });

        return [
          ...buckets,
          {
            labels: { group, le: "+Inf" },
            value: counts.requests,
            suffix: "_bucket" as const,
          },
          {
            labels: { group },
            value: counts.latency_ms.sum / 1000,
            suffix: "_sum" as const,
          },
          {
            labels: { group },
            value: counts.requests,
            suffix: "_count" as const,
          },
        ];
      }),
    },
  ];

  if (input.pool) {
    const pool = input.pool;

    families.push({
      name: "trajetto_db_pool_connections",
      help: "Conexões do pool principal do Prisma, por estado.",
      type: "gauge",
      samples: (["open", "busy", "idle", "waiting"] as const).map((each) => ({
        labels: { pool: each },
        value: pool[each],
      })),
    });

    if (pool.limit !== null) {
      families.push({
        name: "trajetto_db_pool_limit",
        help: "O teto do pool principal (connection_limit).",
        type: "gauge",
        samples: [{ value: pool.limit }],
      });
    }
  }

  if (input.sockets) {
    families.push(
      {
        name: "trajetto_sockets_connected",
        help: "Sockets conectados a este processo.",
        type: "gauge",
        samples: [
          {
            labels: { adapter: input.sockets.adapter },
            value: input.sockets.local,
          },
        ],
      },
      {
        name: "trajetto_sockets_cap",
        help: "O teto de sockets deste processo.",
        type: "gauge",
        samples: [{ value: input.sockets.cap }],
      },
    );
  }

  return families;
}

/** A fixed-length digest, so the comparison never leaks the length. */
const digest = (text: string) => createHash("sha256").update(text).digest();

/** Whether the request carries the token, compared in constant time. */
function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;

  return timingSafeEqual(
    digest(header.slice("Bearer ".length).trim()),
    digest(token),
  );
}

/**
 * Whether this process opens /metrics, and where: only with METRICS_PORT,
 * and only with its token (the env-schema refuses the port without one;
 * this is the second lock). Null: no port is opened.
 */
function metricsServerSettings(values: {
  METRICS_PORT?: number;
  METRICS_TOKEN?: string;
}): { port: number; token: string } | null {
  if (values.METRICS_PORT === undefined) return null;
  if (!values.METRICS_TOKEN || values.METRICS_TOKEN.length < 32) return null;

  return { port: values.METRICS_PORT, token: values.METRICS_TOKEN };
}

interface MetricsServer {
  port: number;
  close(): Promise<void>;
}

interface MetricsServerOptions {
  port: number;
  token: string;
  host?: string;
  collect?: () => Promise<MetricFamily[]>;
}

/** The scrape server: GET /metrics with the token, and nothing else. */
async function startMetricsServer(
  options: MetricsServerOptions,
): Promise<MetricsServer> {
  const collect = options.collect ?? collectPrometheus;

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];

    response.setHeader("cache-control", "no-store");

    if (path !== "/metrics") {
      response.writeHead(404).end();
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }

    if (!authorized(request.headers.authorization, options.token)) {
      response.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }

    void collect()
      .then((families) => {
        const { text, refused } = renderPrometheus(families);

        if (refused.length > 0) {
          log.error({ refused }, "metrics series refused: a label is not safe");
        }

        response
          .writeHead(200, {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
          })
          .end(request.method === "HEAD" ? undefined : text);
      })
      .catch((error: unknown) => {
        log.error({ err: error }, "metrics could not be collected");
        response.writeHead(500).end();
      });
  });

  // A scrape is small and quick: a slow client is not kept.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  server.unref();

  const address = server.address();

  return {
    port: typeof address === "object" && address ? address.port : options.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** For tests: no source, no verdict. */
function resetPrometheus(): void {
  readers.clear();
  alertVerdict = null;
  alertCodes = [];
}

export {
  METRIC_LABELS,
  collectPrometheus,
  metricsServerSettings,
  processFamilies,
  recordAlertVerdict,
  refusedLabel,
  registerPrometheusFamilies,
  renderPrometheus,
  resetPrometheus,
  startMetricsServer,
};
export type {
  MetricFamily,
  MetricSample,
  MetricsServer,
  MetricType,
  ProcessInputs,
};
