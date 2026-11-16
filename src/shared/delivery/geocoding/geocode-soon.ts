import { logger } from "@/shared/logging/logger";

import { GEOCODING_RUN_DEFAULTS } from "./delivery-geocoding-service";
import { deliveryGeocodingEnabled } from "./geocoding-enabled";
import {
  closeGeocodingRedis,
  deliveryGeocodingService,
  logGeocodingRun,
} from "./geocoding-runtime";

/**
 * The address lookup right after the write that needs it (owner's report of
 * 09/11/2026: a delivery created and routed at once showed "Sem
 * localização" on the route page, because the point only came with the
 * next minute's job, and the open page never learned of it). A create
 * without a point, an address edit, and the deliveries a routing put on a
 * route ask for their point here, AFTER the commit:
 *
 * - never awaited by the request, and never failing it: the answer it gives
 *   does not wait for the provider, and nothing here throws to the caller;
 * - one run at a time per process, through a small queue: a burst of
 *   creates (an ERP pushing a hundred deliveries) is one stream of lookups,
 *   never a hundred concurrent claims on the database pool. Past
 *   SOON_PENDING_MAX waiting ids the rest is left to the job (with a log
 *   line), which takes the open stops of unfinished routes first;
 * - the same claim as the job (claimByIds, FOR UPDATE SKIP LOCKED with the
 *   lease) over those ids of that company, within the same daily budget,
 *   pause and per-second slot shared by every replica — so the job and this
 *   never ask about the same address, and together never pass the
 *   provider's rate;
 * - an answer that is not about the address (an outage, a refusal, a 429)
 *   gives the claim back unspent, and the job asks again next minute.
 *
 * The spreadsheet and XML imports stay on the job: a thousand rows must not
 * become a thousand lookups ahead of everybody else's.
 */
const log = logger.child({ component: "geocoding", path: "soon" });

/** Ids waiting in one process, every company together. */
const SOON_PENDING_MAX = 100;

type SoonRun = (businessId: string, deliveryIds: string[]) => Promise<void>;

class GeocodeSoonQueue {
  private readonly pending = new Map<string, Set<string>>();
  private size = 0;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly run: SoonRun,
    private readonly limit = SOON_PENDING_MAX,
    private readonly chunk = GEOCODING_RUN_DEFAULTS.batchSize,
  ) {}

  add(businessId: string, deliveryIds: readonly string[]): void {
    if (this.closed) return;

    let left = 0;

    for (const id of deliveryIds) {
      const waiting = this.pending.get(businessId) ?? new Set<string>();

      if (waiting.has(id)) continue;

      if (this.size >= this.limit) {
        left += 1;
        continue;
      }

      waiting.add(id);
      this.pending.set(businessId, waiting);
      this.size += 1;
    }

    // Not lost: the job takes the open stops first, the routed ones too.
    if (left > 0) {
      log.info(
        { businessId, left },
        "address lookup queue full: the rest is left to the job",
      );
    }

    this.kick();
  }

  /** Resolves when nothing is waiting or running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Stops taking ids and drops what waits: the job finds them. */
  close(): void {
    this.closed = true;
    this.pending.clear();
    this.size = 0;
  }

  private kick(): void {
    if (this.running || this.closed || this.size === 0) return;

    this.running = this.drain().finally(() => {
      this.running = null;

      // Ids added between the loop's last check and here.
      this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.pending.size > 0) {
      const [businessId, waiting] = this.pending.entries().next().value as [
        string,
        Set<string>,
      ];

      // A chunk per turn, and the company to the back of the line: one
      // company's forty stops do not hold another's single create.
      const ids = [...waiting].slice(0, this.chunk);

      this.pending.delete(businessId);

      for (const id of ids) waiting.delete(id);

      this.size -= ids.length;

      if (waiting.size > 0) this.pending.set(businessId, waiting);

      try {
        await this.run(businessId, ids);
      } catch (err) {
        log.warn({ err, businessId }, "address lookup after the write failed");
      }
    }
  }
}

let queue: GeocodeSoonQueue | null = null;

function soonQueue(): GeocodeSoonQueue {
  queue ??= new GeocodeSoonQueue(async (businessId, ids) => {
    logGeocodingRun(
      "soon",
      await deliveryGeocodingService().runFor(businessId, ids),
    );
  });

  return queue;
}

/**
 * Asks for these deliveries' points soon, in the background. A no-op with
 * the lookup off (no provider, or a zero budget) or nothing to ask.
 */
function geocodeSoon(businessId: string, deliveryIds: readonly string[]): void {
  try {
    if (deliveryIds.length === 0 || !deliveryGeocodingEnabled()) return;

    soonQueue().add(businessId, deliveryIds);
  } catch (err) {
    // Synchronous by contract: whatever happens here, the caller's write
    // has committed and its answer goes out.
    log.warn({ err, businessId }, "address lookup after the write not queued");
  }
}

/**
 * The deliveries still without a point that the lookup may still want: no
 * coordinates and no source (a MANUAL point is never looked up). Whether
 * they are claimable is the claim's to decide.
 */
function unlocatedDeliveryIds(
  deliveries: ReadonlyArray<{
    id?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    geo_source?: string | null;
  }>,
): string[] {
  return deliveries
    .filter(
      (delivery) =>
        delivery.id &&
        (delivery.latitude == null || delivery.longitude == null) &&
        delivery.geo_source == null,
    )
    .map((delivery) => delivery.id as string);
}

/**
 * On the way out: no new lookups, and the process's Redis connection
 * closed, within `deadlineMs` when the shutdown gives one (what is left of
 * its workers step). A lookup still in flight keeps its claim until the
 * back-off lease (15 min) frees it for the job.
 */
async function shutdownDeliveryGeocoding(
  options: { deadlineMs?: number } = {},
): Promise<void> {
  queue?.close();
  queue = null;

  await closeGeocodingRedis(options);
}

export {
  GeocodeSoonQueue,
  SOON_PENDING_MAX,
  geocodeSoon,
  shutdownDeliveryGeocoding,
  unlocatedDeliveryIds,
};
