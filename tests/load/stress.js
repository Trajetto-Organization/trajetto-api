import { pause, runOneOperation } from "./lib/mix.js";

/**
 * Past the ceiling, on purpose.
 *
 * The question is not "does it hold" — it will not, at some rate. The question
 * is WHICH THING breaks first and what it does when it breaks: a pool that
 * queues is recoverable, a process that runs out of memory is not, and a
 * database that starts refusing connections takes the healthy replicas with
 * it.
 *
 * No latency thresholds here, deliberately. A stress run that "fails" on p95
 * tells nobody anything; the output to read is the shape of the curve and the
 * first surface whose error rate leaves zero.
 */
export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",

      startRate: 50,
      timeUnit: "1s",

      preAllocatedVUs: 100,
      maxVUs: 1500,

      stages: [
        { target: 100, duration: "45s" },
        { target: 250, duration: "45s" },
        { target: 500, duration: "45s" },
        { target: 900, duration: "45s" },

        // Back down, to see whether it recovers or stays broken. A system
        // that never comes back is a different (worse) finding than one that
        // simply queued.
        { target: 100, duration: "45s" },
      ],
    },
  },

  thresholds: {
    // One guard only: the process must still be answering something at the
    // end. A run that ends in a wall of connection refusals is a crash, not
    // a load profile.
    "surface_failures{surface:system.health}": ["rate<0.5"],
  },
};

export default function stress() {
  runOneOperation(__VU);
  pause(0.2, 0.8);
}
