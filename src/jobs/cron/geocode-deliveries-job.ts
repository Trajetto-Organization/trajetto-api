import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { deliveryGeocodingOffReason } from "@/shared/delivery/geocoding/geocoding-enabled";
import {
  deliveryGeocodingService,
  logGeocodingRun,
} from "@/shared/delivery/geocoding/geocoding-runtime";

const log = logger.child({ component: "cron", job: "geocode-deliveries" });

/** Whether this process already said the job is off (once is enough). */
let offLogged = false;

/**
 * The address points of new deliveries (plan of 02/11/2026, E1; decision
 * D15): every minute, the newest open deliveries without a point are looked
 * up on the Nominatim-compatible provider (REVERSE_GEOCODER_*), within
 * DELIVERY_GEOCODING_DAILY_BUDGET lookups a day across every replica. The
 * job is the guarantee; a create, an address edit or a routing also asks
 * right after its commit (geocode-soon.ts), within the same budget.
 *
 * One replica per minute (the scheduler's lease), and the claim is a
 * FOR UPDATE SKIP LOCKED pick that leases its rows, so a catch-up run, a
 * second replica or a lookup after a commit never asks twice about the same
 * address. A run with nothing to do is the normal case and logs nothing;
 * one that did something logs its counts and, when it stopped short, the
 * provider's HTTP statuses (logGeocodingRun). Without a provider or with a
 * zero budget it does nothing at all — not even a Redis connection — and
 * says so once per process, so a staging that never geocodes shows why.
 */
const geocodeDeliveriesJob: CronJobDefinition = {
  name: "geocode-deliveries",
  schedule: "* * * * *",
  quiet: true,

  async handler() {
    const off = deliveryGeocodingOffReason();

    if (off) {
      if (!offLogged) {
        offLogged = true;
        log.info(
          { reason: off },
          "geocode-deliveries off: delivery addresses get no point but a typed or pinned one",
        );
      }

      return;
    }

    offLogged = false;

    logGeocodingRun("job", await deliveryGeocodingService().runOnce());
  },
};

export { geocodeDeliveriesJob };
