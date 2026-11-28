import { afterEach, describe, expect, it } from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { ALERT_KINDS } from "@/shared/health/alert-rules";
import { HTTP_LATENCY_BUCKETS_MS } from "@/shared/health/http-metrics";
import {
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
  type MetricsServer,
  type ProcessInputs,
} from "@/shared/health/prometheus";
import { ROUTE_GROUPS } from "@/shared/health/route-groups";

/**
 * `/metrics` in the Prometheus format (plano-escala F5-29).
 *
 * The port is reached by anything on the dokploy-network, which staging
 * and production share, and whatever it serves ends up in a time-series
 * database kept for months. So the three promises are tested as the
 * scraper and an intruder would meet them:
 *
 *  - the format: what vmagent parses (HELP, TYPE, escaped labels, the
 *    histogram's series), with no NaN where a number is missing;
 *  - the label guard: a label name outside the list, or a value that looks
 *    like an id, an e-mail, an IP or a document, never goes out, and the
 *    refusal is counted; the process's own families pass it;
 *  - the refusal: no port without METRICS_PORT, the boot refuses the port
 *    without a token of 32 characters, and the server answers 401 to a
 *    scrape without the right token.
 */
const TOKEN = "t".repeat(40);

const ENV = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  TURNSTILE_SECRET_KEY: "0x4AAAAAAATEST-turnstile-secret",
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

function counts(requests: number) {
  return {
    requests,
    classes: {
      "2xx": requests - 2,
      "3xx": 0,
      "4xx": 1,
      "5xx": 1,
      "429": 1,
      "503": 1,
    },
    latency_ms: {
      counts: [
        requests - 1,
        ...new Array(HTTP_LATENCY_BUCKETS_MS.length - 1).fill(0),
        1,
      ],
      sum: 1234,
    },
  };
}

function inputs(overrides: Partial<ProcessInputs> = {}): ProcessInputs {
  return {
    identity: {
      role: "all",
      appEnv: "staging",
      commit: "7e190ebb7e190ebb7e190ebb7e190ebb7e190ebb",
    },
    uptimeSeconds: 61.4,
    memory: { rss: 200_000_000, heapUsed: 90_000_000 },
    eventLoop: { lagP99Ms: 12.5, utilization: 0.31 },
    latencyBucketsMs: HTTP_LATENCY_BUCKETS_MS,
    http: Object.fromEntries(ROUTE_GROUPS.map((group) => [group, counts(10)])),
    pool: { open: 5, busy: 2, idle: 3, waiting: 0, limit: 10 },
    sockets: { local: 42, cap: 5000, adapter: "redis" },
    ...overrides,
  };
}

/** Every `name{labels} value` line, as a map of label sets. */
function seriesOf(text: string): Array<{
  name: string;
  labels: Record<string, string>;
  value: string;
}> {
  return text
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = /^([a-z_][a-z0-9_]*)(\{(.*)\})? (\S+)$/.exec(line);

      if (!match) throw new Error(`linha fora do formato: ${line}`);

      const labels = Object.fromEntries(
        [...(match[3] ?? "").matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)].map(
          (pair) => [pair[1], pair[2]],
        ),
      );

      return { name: match[1], labels, value: match[4] };
    });
}

afterEach(() => resetPrometheus());

describe("the text format", () => {
  it("writes HELP and TYPE, sorted and escaped labels, and the histogram's series", () => {
    const { text, refused } = renderPrometheus([
      {
        name: "trajetto_example_total",
        help: "Linha um\nlinha dois \\ barra",
        type: "counter",
        samples: [
          { labels: { role: "api", class: '5"xx\\\n' }, value: 3 },
          { value: Number.NaN },
        ],
      },
      {
        name: "trajetto_wait_seconds",
        help: "Espera.",
        type: "histogram",
        samples: [
          { labels: { le: "0.5" }, value: 1, suffix: "_bucket" },
          { labels: { le: "+Inf" }, value: 2, suffix: "_bucket" },
          { value: 0.7, suffix: "_sum" },
          { value: 2, suffix: "_count" },
        ],
      },
    ]);

    expect(refused).toEqual([]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain(
      "# HELP trajetto_example_total Linha um\\nlinha dois \\\\ barra",
    );
    expect(text).toContain("# TYPE trajetto_example_total counter");
    expect(text).toContain(
      'trajetto_example_total{class="5\\"xx\\\\\\n",role="api"} 3',
    );
    expect(text).toContain("trajetto_example_total NaN");
    expect(text).toContain("# TYPE trajetto_wait_seconds histogram");
    expect(text).toContain('trajetto_wait_seconds_bucket{le="+Inf"} 2');
    expect(text).toContain("trajetto_wait_seconds_sum 0.7");
    expect(text).toContain("trajetto_wait_seconds_count 2");
    expect(text).toContain("trajetto_metrics_refused_series 0");
  });

  it("gives the process's families in the format, the histogram cumulative", () => {
    const { text, refused } = renderPrometheus(processFamilies(inputs()));

    expect(refused).toEqual([]);

    const series = seriesOf(text);
    const positions = series.filter(
      (each) =>
        each.name === "trajetto_http_request_duration_seconds_bucket" &&
        each.labels.group === "positions",
    );

    expect(positions.map((each) => Number(each.value))).toEqual([
      ...new Array(HTTP_LATENCY_BUCKETS_MS.length).fill(9),
      10,
    ]);
    expect(
      series.find((each) => each.name === "trajetto_build_info")?.labels,
    ).toEqual({ role: "all", app_env: "staging", commit: "7e190ebb7e19" });
  });

  it("leaves out the event loop's lag instead of writing a number it does not have", () => {
    const { text } = renderPrometheus(
      processFamilies(
        inputs({ eventLoop: { lagP99Ms: null, utilization: 0 }, pool: null }),
      ),
    );

    expect(text).not.toMatch(/^trajetto_event_loop_lag_p99_seconds /m);
    expect(text).not.toContain("trajetto_db_pool_connections{");
  });
});

describe("the label guard", () => {
  it.each([
    ["businessId", "abc"],
    ["tenant", "abc"],
    ["user", "abc"],
    ["route", "/route/positions"],
  ])("refuses the label name %s", (name, value) => {
    expect(refusedLabel(name, value)).not.toBeNull();
  });

  it.each([
    ["uuid", "018fe0c5-0000-7000-8000-00000000000a"],
    ["uuid without dashes", "018fe0c500007000800000000000000a"],
    ["email", "motorista@example.com"],
    ["IPv4", "10.0.1.15"],
    ["IPv6", "fe80::1:2:3"],
    ["CPF", "52998224725"],
    ["CNPJ", "62000000000123"],
    ["a long value", "x".repeat(65)],
  ])("refuses a value that looks like %s", (_kind, value) => {
    expect(refusedLabel("group", value)).not.toBeNull();
  });

  it("drops the refused series, keeps the rest, and counts the refusal", () => {
    const { text, refused } = renderPrometheus([
      {
        name: "trajetto_sessions",
        help: "Sessões.",
        type: "gauge",
        samples: [
          {
            labels: { businessId: "018fe0c5-0000-7000-8000-00000000000a" },
            value: 1,
          },
          { labels: { group: "tower" }, value: 2 },
        ],
      },
      { name: "sessions_per_company", help: "x", type: "gauge", samples: [] },
    ]);

    expect(refused).toHaveLength(2);
    expect(text).not.toContain("018fe0c5");
    expect(text).not.toContain("sessions_per_company");
    expect(text).toContain('trajetto_sessions{group="tower"} 2');
    expect(text).toContain("trajetto_metrics_refused_series 2");
  });

  it("lets through every route group and every alert code, and nothing of the process's families is refused", () => {
    for (const group of ROUTE_GROUPS) {
      expect(refusedLabel("group", group), group).toBeNull();
    }

    for (const code of ALERT_KINDS) {
      expect(refusedLabel("code", code), code).toBeNull();
    }

    const names = new Set(
      seriesOf(renderPrometheus(processFamilies(inputs())).text).flatMap(
        (each) => Object.keys(each.labels),
      ),
    );

    for (const name of names) {
      expect(METRIC_LABELS as readonly string[]).toContain(name);
    }
  });
});

describe("the alerts on /metrics", () => {
  it("are every code, 1 for the ones the heartbeat judged active, in the process that judged them", async () => {
    expect(await collectPrometheus()).toEqual([]);

    recordAlertVerdict(
      ALERT_KINDS,
      ["outbox-lag"],
      new Date(1_700_000_000_000),
    );

    const series = seriesOf(renderPrometheus(await collectPrometheus()).text);
    const active = series.filter(
      (each) => each.name === "trajetto_alert_active",
    );

    expect(active).toHaveLength(ALERT_KINDS.length);
    expect(active.filter((each) => each.value === "1")).toEqual([
      {
        name: "trajetto_alert_active",
        labels: { code: "outbox-lag" },
        value: "1",
      },
    ]);
    expect(
      series.find(
        (each) => each.name === "trajetto_alert_evaluated_timestamp_seconds",
      )?.value,
    ).toBe("1700000000");
  });

  it("skip a source that throws and keep the others", async () => {
    registerPrometheusFamilies("broken", () => {
      throw new Error("fora do ar");
    });
    registerPrometheusFamilies("fine", () => [
      {
        name: "trajetto_fine",
        help: "x",
        type: "gauge",
        samples: [{ value: 1 }],
      },
    ]);

    expect((await collectPrometheus()).map((each) => each.name)).toEqual([
      "trajetto_fine",
    ]);
  });
});

describe("the refusal", () => {
  it("opens no port without METRICS_PORT, the default", () => {
    const parsed = envSchema.parse(ENV);

    expect(parsed.METRICS_PORT).toBeUndefined();
    expect(metricsServerSettings(parsed)).toBeNull();
  });

  it("refuses the boot with METRICS_PORT and no token, or a short one, or the API's port", () => {
    for (const extra of [
      { METRICS_PORT: "9464" },
      { METRICS_PORT: "9464", METRICS_TOKEN: "" },
      { METRICS_PORT: "9464", METRICS_TOKEN: "short" },
      { METRICS_PORT: "3333", METRICS_TOKEN: TOKEN },
    ]) {
      expect(
        envSchema.safeParse({ ...ENV, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }

    const parsed = envSchema.parse({
      ...ENV,
      METRICS_PORT: "9464",
      METRICS_TOKEN: TOKEN,
    });

    expect(metricsServerSettings(parsed)).toEqual({ port: 9464, token: TOKEN });
    // The second lock, if a value ever got past the schema.
    expect(
      metricsServerSettings({ METRICS_PORT: 9464, METRICS_TOKEN: "x" }),
    ).toBeNull();
  });

  describe("the server", () => {
    let server: MetricsServer;

    afterEach(async () => server?.close());

    async function scrape(
      path: string,
      init: { method?: string; token?: string } = {},
    ) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: init.method ?? "GET",
        headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
      });

      return {
        status: response.status,
        type: response.headers.get("content-type"),
        body: await response.text(),
      };
    }

    it("answers 401 without the token or with a wrong one, and the metrics with it", async () => {
      server = await startMetricsServer({
        port: 0,
        host: "127.0.0.1",
        token: TOKEN,
        collect: async () => processFamilies(inputs()),
      });

      for (const token of [undefined, "wrong", `${TOKEN}x`]) {
        const refused = await scrape("/metrics", { token });

        expect(refused.status, String(token)).toBe(401);
        expect(refused.body).toBe("");
      }

      const scraped = await scrape("/metrics", { token: TOKEN });

      expect(scraped.status).toBe(200);
      expect(scraped.type).toBe("text/plain; version=0.0.4; charset=utf-8");
      expect(scraped.body).toContain("trajetto_build_info{");

      expect((await scrape("/health", { token: TOKEN })).status).toBe(404);
      expect(
        (await scrape("/metrics", { method: "POST", token: TOKEN })).status,
      ).toBe(405);
    });
  });
});
