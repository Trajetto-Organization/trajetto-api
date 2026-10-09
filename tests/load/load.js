import { perSurfaceBreakdown } from "./lib/api.js";
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

      // Every iteration also pauses 0.5–2 s (a client, not a fuzzer), so one
      // VU sustains under one iteration a second: 400 VUs capped the run near
      // 300/s whatever LOAD_RATE asked, and the excess showed up only as
      // dropped_iterations. The budget now follows the rate.
      preAllocatedVUs: Number(__ENV.LOAD_PRE_VUS || Math.max(60, Math.ceil(Number(__ENV.LOAD_RATE || 120) * 0.5))),
      maxVUs: Number(__ENV.LOAD_MAX_VUS || Math.max(400, Math.ceil(Number(__ENV.LOAD_RATE || 120) * 3))),
    },
  },

  thresholds: {
    ...perSurfaceBreakdown(),

    // The whole product answering in under a second at p95. Not a number
    // borrowed from anywhere: it is what a dispatcher notices.
    "surface_latency{surface:delivery.list}": ["p(95)<1000"],
    "surface_latency{surface:delivery.mine}": ["p(95)<1000"],
    "surface_latency{surface:route.tower}": ["p(95)<1500"],
    "surface_latency{surface:route.positions}": ["p(95)<800"],

    surface_failures: ["rate<0.01"],

    /**
     * Throttling is an ANSWER, not a failure.
     *
     * `http_req_failed` is k6's own metric and it counts any non-2xx, so a
     * rate limiter doing its job pushed a perfectly healthy run into the red:
     * zero product failures, a p95 of 25ms, and a threshold breach caused
     * entirely by the 429s the product is supposed to send. A suite that
     * reports red on a good run is a suite people stop reading.
     *
     * The ceiling stays, because a flood of 429s IS worth knowing about — it
     * says the mix is asking for more than a real client would. It is just
     * measured with the metric that knows the difference.
     */
    surface_throttled: ["rate<0.10"],
  },
};

export default function load() {
  runOneOperation(__VU);
  pause();
}
