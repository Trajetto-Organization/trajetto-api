import { pause, runOneOperation } from "./lib/mix.js";

/**
 * A normal busy hour.
 *
 * Arrival-rate based, not VU based: an operation does not send fewer requests
 * because the server got slower, and a closed-loop test that throttles itself
 * when latency rises is a test that cannot see the thing it exists to find.
 *
 * The rate is read from the ruler in the capacity notes and scaled to one
 * machine: the reference operation is ~4 deliveries a second at the daily
 * average with peaks of 20–40, and every delivery drags six to ten events —
 * so a few hundred operations a second is the honest shape of a busy hour.
 */
export const options = {
  scenarios: {
    busy_hour: {
      executor: "constant-arrival-rate",

      rate: Number(__ENV.LOAD_RATE || 120),
      timeUnit: "1s",

      duration: __ENV.LOAD_DURATION || "3m",

      preAllocatedVUs: 60,
      maxVUs: 400,
    },
  },

  thresholds: {
    // The whole product answering in under a second at p95. Not a number
    // borrowed from anywhere: it is what a dispatcher notices.
    "surface_latency{surface:delivery.list}": ["p(95)<1000"],
    "surface_latency{surface:delivery.mine}": ["p(95)<1000"],
    "surface_latency{surface:route.tower}": ["p(95)<1500"],
    "surface_latency{surface:route.positions}": ["p(95)<800"],

    surface_failures: ["rate<0.01"],
    http_req_failed: ["rate<0.02"],
  },
};

export default function load() {
  runOneOperation(__VU);
  pause();
}
