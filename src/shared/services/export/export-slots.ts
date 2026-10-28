import { ServiceBusyError } from "@/shared/errors/service-busy-error";

/**
 * How many exports one replica streams at once: three in all, one per
 * company.
 *
 * An export holds a database cursor, a pool connection between batches and
 * the socket for as long as the client reads, and the Excel one builds the
 * zip on the event loop. The route's rate limit (10 a minute per address)
 * bounds how often one person starts one, not how many run at the same time:
 * a company's five dispatchers, or one double-click, each held a cursor on
 * the same replica while every other tenant's requests queued for the pool.
 *
 * Per replica, in memory: a slot is freed by the request that took it, so a
 * replica that dies frees its own with it, and nothing needs a lock in Redis
 * (ADR 0002). With N replicas the deployment streams at most 3·N exports and
 * N per company.
 */
const EXPORTS_PER_REPLICA = 3;
const EXPORTS_PER_TENANT = 1;

/** What the refusal tells the client to wait: an export takes seconds. */
const EXPORT_RETRY_AFTER_SECONDS = 15;

class ExportSlots {
  private running = 0;

  private readonly perTenant = new Map<string, number>();

  constructor(
    private readonly replicaLimit = EXPORTS_PER_REPLICA,
    private readonly tenantLimit = EXPORTS_PER_TENANT,
  ) {}

  /**
   * Takes a slot for `tenant`, or refuses with 429 EXPORT_BUSY before a byte
   * of the file is sent. The returned release is idempotent.
   */
  acquire(tenant: string): () => void {
    const ofTenant = this.perTenant.get(tenant) ?? 0;

    if (ofTenant >= this.tenantLimit) {
      throw new ServiceBusyError(
        "Já existe uma exportação desta empresa em andamento. Aguarde ela terminar e tente de novo.",
        "EXPORT_BUSY",
        EXPORT_RETRY_AFTER_SECONDS,
        429,
      );
    }

    if (this.running >= this.replicaLimit) {
      throw new ServiceBusyError(
        "Muitas exportações em andamento agora. Tente de novo em alguns segundos.",
        "EXPORT_BUSY",
        EXPORT_RETRY_AFTER_SECONDS,
        429,
      );
    }

    this.running += 1;
    this.perTenant.set(tenant, ofTenant + 1);

    let released = false;

    return () => {
      if (released) return;
      released = true;

      this.running -= 1;

      const left = (this.perTenant.get(tenant) ?? 1) - 1;

      if (left > 0) this.perTenant.set(tenant, left);
      else this.perTenant.delete(tenant);
    };
  }

  /** Streams in progress on this replica (tests, metrics). */
  inProgress(): number {
    return this.running;
  }
}

/** This replica's slots, shared by every export route. */
const exportSlots = new ExportSlots();

export {
  EXPORTS_PER_REPLICA,
  EXPORTS_PER_TENANT,
  EXPORT_RETRY_AFTER_SECONDS,
  ExportSlots,
  exportSlots,
};
