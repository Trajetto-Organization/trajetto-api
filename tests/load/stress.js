import { perSurfaceBreakdown, surfaces } from "./lib/api.js";
import { stagesDuration } from "./lib/duration.js";
import { pause, runOneOperation } from "./lib/mix.js";

/**
 * The steps, overridable (STRESS_TARGETS="300,600,900,1200,1500") so a run can
 * keep climbing when the default top still holds; STRESS_STEP sets each
 * step's length.
 */
const STEP = __ENV.STRESS_STEP || "45s";
const TARGETS = (__ENV.STRESS_TARGETS || "100,250,500,900")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => value > 0);

const RAMP = [
  ...TARGETS.map((target) => ({ target, duration: STEP })),

  // Back down, to see whether it recovers or stays broken. A system
  // that never comes back is a different (worse) finding than one that
  // simply queued.
  { target: 100, duration: "45s" },
];

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
      maxVUs: Number(
        __ENV.STRESS_MAX_VUS || Math.max(1500, Math.max(...TARGETS) * 2),
      ),

      stages: RAMP,
    },

    /**
     * The health probe, once a second for the whole ramp.
     *
     * The threshold below is on `system.health`, and the mix never calls it
     * (only smoke.js did): the threshold had no sample and passed whatever
     * happened. A steady trickle beside the ramp is also what a load
     * balancer does to a replica under stress.
     */
    health: {
      executor: "constant-arrival-rate",
      exec: "health",
      rate: 1,
      timeUnit: "1s",
      duration: `${stagesDuration(RAMP)}ms`,
      preAllocatedVUs: 2,
      maxVUs: 10,
    },
  },

  thresholds: {
    ...perSurfaceBreakdown(),

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

export function health() {
  surfaces.health();
}
