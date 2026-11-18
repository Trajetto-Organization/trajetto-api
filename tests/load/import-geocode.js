import http from "k6/http";
import encoding from "k6/encoding";
import exec from "k6/execution";
import { sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

import { SUMMARY_TREND_STATS, context, surfaces } from "./lib/api.js";
import { parseDuration } from "./lib/duration.js";
import { spreadsheetRows } from "./lib/spreadsheet.js";

/**
 * A spreadsheet of 20 000 addresses with no point, against the fake
 * geocoder at the LocationIQ Startup plan's limits (plano-escala LOAD-04;
 * the acceptance of F2-31 and F2-32: every row gets its coordinates in
 * under 2 h, and the API never goes past the plan).
 *
 * The harness runs with the `fakes` profile and
 * LOAD_API_ENV_FILE=geocoder-startup.env: the replicas (or the worker, with
 * the roles profile) look the addresses up at https://fake-geocoder:8090,
 * at the plan's rates (17 a second shared, 960 a minute in the background,
 * 45 000 a day for the job), and the fake refuses with 429 what goes past
 * 22 a second or 60 000 a day, as LocationIQ does. Every row's street
 * carries the run's marker, so the fake counts this run's addresses apart
 * from the seed's (`/stats?contains=`).
 *
 * `geocode_ms` runs from the 202 to the moment the fake has answered every
 * address of the file once; `geocoder_refused` counts the 429s the fake
 * had to give, which must stay 0: a gate past the plan's rate is an
 * account paused for every company.
 *
 *   IMPORT_ROWS       addresses (19 999: the header makes 20 000 lines)
 *   GEOCODE_TIMEOUT   how long the lookups may take (2h)
 *   GEOCODE_POLL_S    seconds between two reads of the fake's counts (30)
 *   FAKE_GEOCODER_URL where k6 reads them (https://fake-geocoder:8090;
 *                     its CA is the run's own, so k6 skips the check)
 */
const ROWS = Math.min(19_999, Math.max(1, Number(__ENV.IMPORT_ROWS || 19_999)));
const TIMEOUT = __ENV.GEOCODE_TIMEOUT || "2h";
const POLL_S = Math.max(5, Number(__ENV.GEOCODE_POLL_S || 30));
const FAKE = __ENV.FAKE_GEOCODER_URL || "https://fake-geocoder:8090";

const TIMEOUT_MS = parseDuration(TIMEOUT);

/** From the 202 to the last address answered. */
const geocodeMs = new Trend("geocode_ms", true);
const located = new Rate("geocode_completed");
const refused = new Counter("geocoder_refused");
const answered = new Counter("geocoder_answered");

export const options = {
  summaryTrendStats: SUMMARY_TREND_STATS,

  // Only the fake's counts go over HTTPS here, under a CA of the run that
  // k6 does not know; the API is reached over the harness' plain HTTP.
  insecureSkipTLSVerify: true,

  scenarios: {
    import: {
      executor: "shared-iterations",
      exec: "upload",
      vus: 1,
      iterations: 1,
      maxDuration: `${TIMEOUT_MS + 5 * 60_000}ms`,
    },
  },

  thresholds: {
    geocode_completed: ["rate==1"],
    geocode_ms: [`max<${TIMEOUT_MS}`],
    geocoder_refused: ["count==0"],

    "surface_latency{surface:import.spreadsheet}": ["max>=0"],
    "surface_latency{surface:import.get}": ["max>=0"],
  },
};

/** The fake's counts, and this run's distinct addresses among them. */
function fakeStats(marker) {
  const response = http.get(
    `${FAKE}/stats?contains=${encodeURIComponent(marker)}`,
    { tags: { surface: "fake.stats" } },
  );

  return response.status === 200 ? response.json() : null;
}

export function setup() {
  if (!context.shipperId) {
    throw new Error(
      "import-geocode.js: o fixture não tem shipperId. Semeie de novo com o seed.ts atual.",
    );
  }

  const before = fakeStats("");

  if (!before) {
    throw new Error(
      `import-geocode.js: o geocoder falso não responde em ${FAKE}. Suba o harness com --profile fakes e LOAD_API_ENV_FILE=geocoder-startup.env.`,
    );
  }

  return { marker: Date.now().toString(36), refusedBefore: before.refused };
}

export function upload(data) {
  const token = context.managerTokens[0];
  const sheet = spreadsheetRows(ROWS, data.marker, {
    coordinates: false,
  });
  const file = {
    filename: sheet.filename,
    content: encoding.b64encode(sheet.text),
  };
  const accepted = surfaces.importSpreadsheet(file, token, {
    stage: "upload",
  });

  if (accepted.status !== 202) {
    located.add(false);
    exec.test.abort(
      `import-geocode.js: a importação foi recusada com HTTP ${accepted.status}: ${String(accepted.body).slice(0, 300)}`,
    );
  }

  const importId = accepted.json("data.id");
  const start = Date.now();
  let rows = ROWS;
  let done = false;

  while (Date.now() - start < TIMEOUT_MS) {
    sleep(POLL_S);

    if (!done) {
      const report = surfaces.getImport(importId, token, { stage: "poll" });

      if (
        report.status === 200 &&
        report.json("data.status") !== "IN_PROGRESS"
      ) {
        done = true;
        rows = Number(report.json("data.imported") || 0);

        console.log(
          `import-geocode: importação em ${Math.round((Date.now() - start) / 1000)} s, ${rows} entregas sem ponto`,
        );
      }
    }

    const stats = fakeStats(data.marker);

    if (!stats) continue;

    console.log(
      `import-geocode: ${stats.matching} de ${rows} endereços respondidos em ${Math.round((Date.now() - start) / 60_000)} min (pico ${stats.maxPerSecond}/s, ${stats.refused - data.refusedBefore} recusas)`,
    );

    if (done && stats.matching >= rows) {
      geocodeMs.add(Date.now() - start);
      answered.add(stats.matching);
      refused.add(stats.refused - data.refusedBefore);
      located.add(true);

      return;
    }
  }

  const stats = fakeStats(data.marker);

  refused.add(stats ? stats.refused - data.refusedBefore : 0);
  answered.add(stats ? stats.matching : 0);
  located.add(false);
}
