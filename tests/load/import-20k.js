import encoding from "k6/encoding";
import exec from "k6/execution";
import { sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

import {
  SUMMARY_TREND_STATS,
  breakdownOf,
  context,
  surfaces,
} from "./lib/api.js";
import { parseDuration } from "./lib/duration.js";
import { spreadsheetRows } from "./lib/spreadsheet.js";

/**
 * A spreadsheet of 20 000 lines while the panel keeps reading
 * (plano-escala LOAD-04; the acceptance of the import as a durable job,
 * wave 14: the api's event-loop lag p99 under 100 ms and its peak RSS
 * within the container's ceiling).
 *
 * The import answers 202 and processes the rows after the answer, on the
 * replica that took it, one at a time (import-queue.ts): its parse and its
 * one query per row share that replica's event loop with every other
 * request. The scene uploads the file once (`import`, polling the import
 * until it leaves IN_PROGRESS) while `probe` reads the board at a steady
 * rate the whole time (`stage:import`), the dispatcher next door.
 *
 * The lag and the RSS are the replicas' own numbers, minute by minute, in
 * their ops_sample rows: k6 prints the window at the end, and
 * lib/ops-window.mjs judges it (README, "As cenas de fila e importação").
 * The rows carry their points (Latitude and Longitude), so no geocoder is
 * involved: import-geocode.js is the one with the lookups.
 *
 *   IMPORT_ROWS            data rows (19 999: the header makes 20 000 lines,
 *                          the importer's ceiling)
 *   IMPORT_TIMEOUT         how long the import may take (30m)
 *   IMPORT_PROBE_RATE      board reads a second meanwhile (5)
 *   IMPORT_PROBE_DURATION  how long they go on (10m)
 */
const ROWS = Math.min(19_999, Math.max(1, Number(__ENV.IMPORT_ROWS || 19_999)));
const TIMEOUT = __ENV.IMPORT_TIMEOUT || "30m";
const PROBE_RATE = Math.max(1, Number(__ENV.IMPORT_PROBE_RATE || 5));
const PROBE_DURATION = __ENV.IMPORT_PROBE_DURATION || "10m";

/** From the 202 to the import leaving IN_PROGRESS. */
const importMs = new Trend("import_ms", true);
const completed = new Rate("import_completed");
const imported = new Counter("import_rows_imported");
const invalid = new Counter("import_rows_invalid");

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,

  setupTimeout: "120s",

  scenarios: {
    import: {
      executor: "shared-iterations",
      exec: "upload",
      vus: 1,
      iterations: 1,
      maxDuration: `${parseDuration(TIMEOUT) + 60_000}ms`,
    },

    probe: {
      executor: "constant-arrival-rate",
      exec: "probe",
      rate: PROBE_RATE,
      timeUnit: "1s",
      duration: PROBE_DURATION,
      preAllocatedVUs: Math.max(5, PROBE_RATE * 2),
      maxVUs: Math.max(20, PROBE_RATE * 10),
    },
  },

  thresholds: {
    import_completed: ["rate==1"],
    import_ms: [`max<${parseDuration(TIMEOUT)}`],
    // Every row a delivery: a rejected row is the scene's file broken, not
    // the server.
    import_rows_invalid: ["count==0"],

    // The dispatcher next door keeps working: after the breakdown, whose
    // always-holding entry for the same key it replaces.
    ...breakdownOf("stage", ["import"]),
    "surface_failures{stage:import}": ["rate<0.01"],

    "surface_latency{surface:import.spreadsheet}": ["max>=0"],
    "surface_latency{surface:import.get}": ["max>=0"],
    "surface_latency{surface:delivery.list}": ["max>=0"],
  },
};

export function setup() {
  if (!context.shipperId) {
    throw new Error(
      "import-20k.js: o fixture não tem shipperId. Semeie de novo com o seed.ts atual.",
    );
  }

  const marker = `${Date.now().toString(36)}`;

  // The file itself is built by the one VU that uploads it: setup's data
  // is copied to every VU of the probe.
  return { marker, startedAt: new Date().toISOString() };
}

/** Uploads, then polls the import until it leaves IN_PROGRESS. */
export function upload(data) {
  const token = context.managerTokens[0];
  const sheet = spreadsheetRows(ROWS, data.marker, {
    coordinates: true,
  });
  const file = {
    filename: sheet.filename,
    content: encoding.b64encode(sheet.text),
  };
  const accepted = surfaces.importSpreadsheet(file, token, {
    stage: "upload",
  });

  if (accepted.status !== 202) {
    completed.add(false);
    exec.test.abort(
      `import-20k.js: a importação foi recusada com HTTP ${accepted.status}: ${String(accepted.body).slice(0, 300)}`,
    );
  }

  const importId = accepted.json("data.id");
  const start = Date.now();
  const deadline = start + parseDuration(TIMEOUT);

  while (Date.now() < deadline) {
    sleep(5);

    const answer = surfaces.getImport(importId, token, { stage: "poll" });

    if (answer.status !== 200) continue;

    if (answer.json("data.status") !== "IN_PROGRESS") {
      importMs.add(Date.now() - start);
      imported.add(Number(answer.json("data.imported") || 0));
      invalid.add(Number(answer.json("data.invalid") || 0));
      completed.add(answer.json("data.status") === "COMPLETED");

      console.log(
        `import-20k: ${importId} em ${Math.round((Date.now() - start) / 1000)} s — importadas ${answer.json("data.imported")}, duplicadas ${answer.json("data.duplicated")}, inválidas ${answer.json("data.invalid")}`,
      );

      return;
    }
  }

  completed.add(false);
}

/** The board, read by the dispatcher next door. */
export function probe() {
  const tokens = context.managerTokens;

  surfaces.tenantDeliveries(
    context.businessId,
    tokens[(exec.scenario.iterationInTest % (tokens.length - 1)) + 1] ??
      tokens[0],
    { stage: "import" },
  );
}

export function teardown(data) {
  console.log(
    `janela das ops_sample: node tests/load/lib/ops-window.mjs --since ${data.startedAt} --until ${new Date().toISOString()}`,
  );
}
