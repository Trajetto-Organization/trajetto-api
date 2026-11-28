import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix, relative, resolve } from "node:path";

import { format, resolveConfig } from "prettier";
import { afterEach, describe, expect, it } from "vitest";

import {
  ALERTS_LABELS,
  DASHBOARDS,
  DATASOURCE,
  METRICS_SCRAPE_PORT,
  PROCESS_RULES,
  SCRAPE_JOBS,
  SCRAPE_LABELS,
  alertCodeRules,
  renderMonitoringFiles,
} from "infra/monitoring/monitoring-config";
import { envShape } from "@/schemas/env-schema/defined-env";
import { ALERT_KINDS, runbookPath } from "@/shared/health/alert-rules";
import { HTTP_LATENCY_BUCKETS_MS } from "@/shared/health/http-metrics";
import {
  METRIC_LABELS,
  collectPrometheus,
  processFamilies,
  recordAlertVerdict,
  renderPrometheus,
  resetPrometheus,
} from "@/shared/health/prometheus";
import { PROCESS_ROLES } from "@/shared/lifecycle/process-role";

/**
 * The metrics stack as versioned configuration (plano-escala F5-30).
 *
 * Nothing in the pipeline runs these files: the owner pastes them into the
 * Dokploy in wave 23, and a mistake shows up only on the day an alert
 * should have fired. So they are checked against the code they watch. A
 * new code in ALERT_KINDS without its vmalert rule (the page would come
 * from healthchecks.io and never show in the history), a metric renamed in
 * prometheus.ts that a rule still reads (a rule on a missing series is
 * silent forever), a new process role without its scrape job, a label that
 * could carry a company, or a file edited by hand and out of step with
 * monitoring-config.ts: each turns this red. That the rules behave (the
 * newest verdict of the environment wins, a stopped heartbeat stops
 * paging) is proven by vmalert itself, with infra/monitoring/vmalert-tests,
 * as the guide says.
 */
const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(resolve(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const files = renderMonitoringFiles();
const guide = read("infra/monitoring/README.md");

async function formatted(path: string, text: string): Promise<string> {
  const absolute = resolve(ROOT, path);
  const options = (await resolveConfig(absolute)) ?? {};

  return format(text, { ...options, filepath: absolute });
}

/** Every file under a folder, as a path from the repository's root. */
function filesUnder(folder: string): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(resolve(ROOT, path))) {
      const child = posix.join(path, name);

      if (statSync(resolve(ROOT, child)).isDirectory()) walk(child);
      else found.push(child);
    }
  };

  walk(folder);

  return found;
}

/** Every PromQL expression the stack evaluates: rules, panels, variables. */
function expressions(): Array<{ where: string; expr: string }> {
  const rules = [...alertCodeRules(), ...PROCESS_RULES].map((rule) => ({
    where: rule.alert,
    expr: rule.expr,
  }));
  const panels = DASHBOARDS.flatMap((dashboard) =>
    dashboard.panels.flatMap((panel) =>
      panel.targets.map((target) => ({
        where: `${dashboard.uid}: ${panel.title}`,
        expr: target.expr,
      })),
    ),
  );

  return [...rules, ...panels];
}

/** The families a process exposes, with every optional source present. */
async function exposedMetrics(): Promise<Set<string>> {
  const counts = {
    requests: 1,
    classes: { "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 0, "429": 0, "503": 0 },
    latency_ms: { counts: HTTP_LATENCY_BUCKETS_MS.map(() => 0), sum: 10 },
  };

  recordAlertVerdict(ALERT_KINDS, []);

  const families = [
    ...processFamilies({
      identity: { role: "all", appEnv: "production", commit: "abc123" },
      uptimeSeconds: 10,
      memory: { rss: 1, heapUsed: 1 },
      eventLoop: { lagP99Ms: 1, utilization: 0.1 },
      latencyBucketsMs: HTTP_LATENCY_BUCKETS_MS,
      http: { positions: counts },
      pool: { open: 1, busy: 0, idle: 1, waiting: 0, limit: 10 },
      sockets: { local: 1, cap: 100, adapter: "redis" },
    }),
    ...(await collectPrometheus()),
  ];
  const { text } = renderPrometheus(families);
  const names = new Set<string>();

  for (const match of text.matchAll(/^# TYPE (\S+) (\S+)$/gm)) {
    names.add(match[1]);

    if (match[2] === "histogram") {
      for (const suffix of ["_bucket", "_sum", "_count"]) {
        names.add(`${match[1]}${suffix}`);
      }
    }
  }

  return names;
}

/** The series an expression reads: ours, the scrape's `up` and vmalert's ALERTS. */
const metricsOf = (expr: string) =>
  [
    ...expr.matchAll(/\b(trajetto_[a-z0-9_]+|up|ALERTS)\b(?=\s*[{[)\s]|$)/g),
  ].map((match) => match[1]);

/** The label names an expression matches, groups or joins on. */
function labelsOf(expr: string): string[] {
  const labels: string[] = [];

  for (const selector of expr.matchAll(/\{([^}]*)\}/g)) {
    for (const matcher of selector[1].matchAll(/(\w+)\s*(?:=~|!~|!=|=)\s*"/g)) {
      labels.push(matcher[1]);
    }
  }

  for (const list of expr.matchAll(
    /\b(?:by|on|without|ignoring|group_left|group_right)\s*\(([^)]*)\)/g,
  )) {
    labels.push(
      ...list[1]
        .split(",")
        .map((each) => each.trim())
        .filter(Boolean),
    );
  }

  return labels;
}

/** GitHub's anchor of a heading (as tests/unitaires/docs/architecture-docs). */
const slug = (heading: string) =>
  heading
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, "")
    .replace(/ /g, "-");

afterEach(() => {
  resetPrometheus();
});

describe("infra/monitoring, the files", () => {
  it("are exactly what yarn monitoring:render writes", async () => {
    for (const [path, text] of Object.entries(files)) {
      expect(existsSync(resolve(ROOT, path)), path).toBe(true);
      expect(read(path), `${path} (rode yarn monitoring:render)`).toBe(
        await formatted(path, text),
      );
    }
  });

  it("has no generated file nobody renders any more", () => {
    const generated = ["vmagent", "vmalert", "grafana"].flatMap((folder) =>
      filesUnder(`infra/monitoring/${folder}`),
    );

    expect(generated.sort()).toEqual(Object.keys(files).sort());
  });

  it("never carries a credential, only the placeholders of the guide", () => {
    for (const path of [...Object.keys(files), "infra/monitoring/README.md"]) {
      const text = read(path).replace(/@sha256:[0-9a-f]{64}/g, "");

      expect(text, path).not.toMatch(/\b[0-9a-f]{32,}\b/i);
      expect(text, path).not.toMatch(/Bearer +(?!<)[A-Za-z0-9]/);
      expect(text, path).not.toMatch(/intrajetto\.com/);
    }
  });
});

describe("vmalert, the rules", () => {
  it("has one rule for every alert code, with its runbook", () => {
    const rules = alertCodeRules();

    expect(rules.map((rule) => rule.expr.match(/code="([^"]+)"/)?.[1])).toEqual(
      [...ALERT_KINDS],
    );

    for (const [index, code] of ALERT_KINDS.entries()) {
      expect(rules[index].runbook).toBe(runbookPath(code));
      expect(rules[index].severity).toBe("page");
    }

    const rendered = files["infra/monitoring/vmalert/alert-codes.yml"];

    expect(rendered.match(/^ {6}- alert: /gm)).toHaveLength(ALERT_KINDS.length);
  });

  it("reads only the newest, fresh verdict of each environment", () => {
    for (const rule of alertCodeRules()) {
      expect(rule.expr, rule.alert).toContain(
        "max by (env) (trajetto_alert_evaluated_timestamp_seconds)",
      );
      expect(rule.expr, rule.alert).toMatch(
        /time\(\) - trajetto_alert_evaluated_timestamp_seconds < \d+/,
      );
      expect(rule.expr, rule.alert).toMatch(/\) == 1$/);
    }
  });

  it("gives every alert a unique name and a runbook that exists", () => {
    const rules = [...alertCodeRules(), ...PROCESS_RULES];
    const names = rules.map((rule) => rule.alert);

    expect(new Set(names).size).toBe(names.length);

    for (const rule of rules) {
      expect(rule.alert).toMatch(/^Trajetto[A-Z][A-Za-z0-9]+$/);

      const [path, anchor] = rule.runbook.split("#");

      expect(existsSync(resolve(ROOT, path)), rule.runbook).toBe(true);

      if (anchor) {
        const headings = read(path)
          .split("\n")
          .filter((line) => /^#{1,6} /.test(line))
          .map((line) => slug(line.replace(/^#+ /, "")));

        expect(headings, rule.runbook).toContain(anchor);
      }
    }
  });

  it("keeps the process rules in observation", () => {
    for (const rule of PROCESS_RULES) {
      expect(rule.severity, rule.alert).toBe("warn");
      expect(rule.source, rule.alert).toBe("metrics");
    }
  });

  it("is proven by the vmalert-tool test the guide runs", () => {
    const proof = read("infra/monitoring/vmalert-tests/rules.test.yml");

    expect(proof).toContain("- ../vmalert/alert-codes.yml");
    expect(proof).toContain("- ../vmalert/process.yml");
    expect(guide).toContain(
      "unittest --files=/monitoring/vmalert-tests/rules.test.yml",
    );

    for (const name of proof.matchAll(/alertname: (\S+)/g)) {
      expect(
        [...alertCodeRules(), ...PROCESS_RULES].map((rule) => rule.alert),
      ).toContain(name[1]);
    }
  });
});

describe("rules and panels against /metrics", () => {
  it("read only series a process exposes", async () => {
    const exposed = await exposedMetrics();

    exposed.add("up");
    exposed.add("ALERTS");

    for (const { where, expr } of expressions()) {
      const read = metricsOf(expr);

      expect(read.length, where).toBeGreaterThan(0);

      for (const name of read)
        expect(exposed, `${where}: ${name}`).toContain(name);
    }
  });

  it("read every family a process exposes, in a panel or a rule", async () => {
    const exposed = await exposedMetrics();
    const used = new Set(expressions().flatMap(({ expr }) => metricsOf(expr)));

    for (const name of exposed) {
      const family = name.replace(/_(bucket|sum|count)$/, "");

      expect(
        used.has(name) || used.has(family) || used.has(`${family}_bucket`),
        name,
      ).toBe(true);
    }
  });

  it("match only labels that cannot name a company or a person", () => {
    const allowed = new Set<string>([
      ...METRIC_LABELS,
      ...SCRAPE_LABELS,
      ...ALERTS_LABELS,
    ]);

    for (const { where, expr } of expressions()) {
      for (const label of labelsOf(expr)) {
        expect(allowed, `${where}: ${label}`).toContain(label);
      }
    }
  });
});

describe("vmagent, the scrape", () => {
  it("has one job for every process role, each once", () => {
    const roles = SCRAPE_JOBS.flatMap((job) => job.roles);

    expect([...roles].sort()).toEqual([...PROCESS_ROLES].sort());
    expect(new Set(SCRAPE_JOBS.map((job) => job.job)).size).toBe(
      SCRAPE_JOBS.length,
    );
  });

  it("finds the replicas by the swarm's DNS and always sends the token", () => {
    for (const job of SCRAPE_JOBS) {
      const text = files[`infra/monitoring/vmagent/jobs/${job.job}.yml`];

      expect(text).toContain(`- job_name: ${job.job}`);
      expect(text).toContain(`"tasks.%{${job.appNameVariable}}"`);
      expect(text).toContain(`port: ${METRICS_SCRAPE_PORT}`);
      expect(text).toContain('credentials: "%{METRICS_TOKEN}"');
      expect(text).toContain("type: Bearer");
      expect(text).toMatch(/sample_limit: \d+/);
      expect(guide, job.appNameVariable).toContain(job.appNameVariable);
    }

    expect(files["infra/monitoring/vmagent/scrape.yml"]).toContain(
      "- /etc/vmagent/jobs/*.yml",
    );
  });

  it("scrapes a port the boot accepts, never the API's", () => {
    const shape = envShape();

    expect(shape.METRICS_PORT.parse(String(METRICS_SCRAPE_PORT))).toBe(
      METRICS_SCRAPE_PORT,
    );
    expect(shape.PORT.parse(undefined)).not.toBe(METRICS_SCRAPE_PORT);
    expect(guide).toContain(`METRICS_PORT=${METRICS_SCRAPE_PORT}`);

    const variables = read("docs/variaveis-de-ambiente.md")
      .split("\n")
      .find((line) => line.startsWith("| `METRICS_PORT`"));

    expect(variables).toContain(`\`${METRICS_SCRAPE_PORT}\``);
  });
});

describe("Grafana, the dashboards", () => {
  it("read the provisioned datasource and cannot be edited in the panel", () => {
    const datasource =
      files[
        "infra/monitoring/grafana/provisioning/datasources/victoriametrics.yml"
      ];

    expect(datasource).toContain(`uid: ${DATASOURCE.uid}`);
    expect(datasource).toContain(
      "basicAuthPassword: $VICTORIA_METRICS_PASSWORD",
    );

    const uids = new Set<string>();

    for (const dashboard of DASHBOARDS) {
      const json = JSON.parse(
        files[`infra/monitoring/grafana/dashboards/${dashboard.file}`],
      ) as {
        uid: string;
        editable: boolean;
        panels: Array<{
          datasource: { uid: string };
          targets: Array<{ datasource: { uid: string } }>;
        }>;
      };

      uids.add(json.uid);
      expect(json.editable).toBe(false);

      for (const panel of json.panels) {
        expect(panel.datasource.uid).toBe(DATASOURCE.uid);

        for (const target of panel.targets) {
          expect(target.datasource.uid).toBe(DATASOURCE.uid);
        }
      }
    }

    expect(uids.size).toBe(DASHBOARDS.length);
  });
});

describe("infra/monitoring/README.md, the guide", () => {
  it("names every file it mounts and where", () => {
    for (const path of Object.keys(files)) {
      const short = relative("infra/monitoring", path).replace(/\\/g, "/");

      if (short.startsWith("vmagent/jobs/")) continue;

      expect(guide, short).toContain(`\`${short}\``);
    }

    expect(guide).toContain("`vmagent/jobs/<Application>.yml`");
  });

  it("pins every image by digest", () => {
    const images = [
      "victoriametrics/vmagent",
      "victoriametrics/victoria-metrics",
      "victoriametrics/vmalert",
      "grafana/grafana",
    ];

    for (const image of images) {
      expect(guide, image).toMatch(
        new RegExp(`${image}:[\\w.-]+@sha256:[0-9a-f]{64}`),
      );
    }

    for (const reference of guide.matchAll(
      /\b(victoriametrics\/[\w-]+|grafana\/grafana):[\w.-]+(@sha256:[0-9a-f]{64})?/g,
    )) {
      expect(reference[2], reference[0]).toBeDefined();
    }
  });

  it("starts vmalert without paging anyone", () => {
    expect(guide).toContain("VM_notifier_blackhole=true");
    expect(guide).not.toMatch(/VM_notifier_url=/);
  });
});
