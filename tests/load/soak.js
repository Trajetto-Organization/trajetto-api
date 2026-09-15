import { pause, runOneOperation } from "./lib/mix.js";

/**
 * A long, dull, moderate run.
 *
 * Finds what a three-minute test cannot: a connection that is opened per
 * request and never closed, a Map that only grows, a lease that is never
 * released, a counter buffer that never flushes. Every one of those looks
 * perfect for five minutes and takes the process down at hour four.
 *
 * The threshold that matters is the LAST window, not the average: a memory
 * leak shows as latency that climbs, and an average over the whole run hides
 * a climb behind a healthy start.
 */
export const options = {
  scenarios: {
    steady: {
      executor: "constant-arrival-rate",

      rate: Number(__ENV.SOAK_RATE || 60),
      timeUnit: "1s",

      duration: __ENV.SOAK_DURATION || "30m",

      preAllocatedVUs: 40,
      maxVUs: 200,
    },
  },

  thresholds: {
    surface_failures: ["rate<0.01"],

    // Deliberately tighter than the load run: at half the rate, a soak that
    // needs the same headroom is already telling you something.
    "surface_latency{surface:delivery.list}": ["p(95)<800"],
    "surface_latency{surface:route.positions}": ["p(95)<600"],
  },
};

export default function soak() {
  runOneOperation(__VU);
  pause(1, 3);
}
