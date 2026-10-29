import { v7 as uuidV7 } from "uuid";

import type {
  IImportRepository,
  ReversalRemovedHook,
} from "../IImport-repository";
import { ImportReversalLeaseLostError } from "../../usecases/errors/import-errors";
import type {
  CreateImportProps,
  FinishImportProps,
  ImportRecord,
  ListImportsProps,
  ListImportsPage,
  ReversalClaim,
  ReversalProgress,
  ReversalResult,
} from "../../dtos/import-dto";
import {
  KEEP_REASON,
  REVERSAL_BATCH_SIZE,
  deliveryKeepReason,
  emptyReversalProgress,
  parseReversalProgress,
  removedDeliveryOf,
  reverseWholeImport,
  reversalResultOf,
  routeKeepReason,
} from "../../services/import-reversal";

import { compareForOrder } from "@/shared/pagination/in-memory-order";
import {
  IMPORT_SORT_FALLBACK,
  type ImportGroup,
} from "../../usecases/list-imports/import-list";

/**
 * The reversal's rules, mirrored.
 *
 * The real one reads counts of events, occurrences and stops out of Postgres;
 * here a test states them directly through the seams below. What must NOT
 * differ is the decision: which rows are removable, and why the others are
 * kept — a fake that removed a delivery the database would refuse to remove
 * would let a test prove the opposite of the truth.
 */
interface ReversibleDelivery {
  id: string;
  businessId: string;
  importId: string | null;
  recipient_name: string;
  status: string;
  code?: string | null;
  invoice_key?: string | null;
  invoice_number?: string | null;
  city?: string;
  uf?: string;
  eventCount?: number;
  occurrenceCount?: number;
}

interface ReversibleRoute {
  id: string;
  businessId: string;
  importId: string | null;
  code: number;
  status: string;
  stopDeliveryIds: string[];
}

class InMemoryImportRepository implements IImportRepository {
  public imports: ImportRecord[] = [];

  public deliveries: ReversibleDelivery[] = [];
  public routes: ReversibleRoute[] = [];

  async createImport(data: CreateImportProps): Promise<ImportRecord> {
    const created: ImportRecord = {
      id: uuidV7(),

      // IN_PROGRESS like the real one. A fake that opened an upload as
      // COMPLETED would let a test prove the undo accepts a running import,
      // which is the one thing the status exists to refuse.
      status: "IN_PROGRESS",

      imported: 0,
      duplicated: 0,
      invalid: 0,

      report: {
        imported: 0,
        duplicated: 0,
        invalid: 0,
        unknownHeaders: [],
        rows: [],
        routes: [],
      },

      reversed_at: null,
      created_at: new Date(),
      ...data,
    };

    this.imports.push(created);

    return created;
  }

  async finishImport(
    importId: string,
    businessId: string,
    data: FinishImportProps,
  ): Promise<ImportRecord> {
    const found = this.imports.find(
      (entry) => entry.id === importId && entry.businessId === businessId,
    );

    if (!found) throw new Error("Import not found");

    // Like the real one: only a running upload is closed.
    if (found.status !== "IN_PROGRESS") return found;

    found.status = "COMPLETED";

    found.imported = data.imported;
    found.duplicated = data.duplicated;
    found.invalid = data.invalid;

    found.report = data.report;

    return found;
  }

  /** When each upload last showed signs of life; absent means at creation. */
  public heartbeats = new Map<string, Date>();

  async touchImport(importId: string, businessId: string): Promise<void> {
    const found = this.imports.find(
      (entry) => entry.id === importId && entry.businessId === businessId,
    );

    if (found?.status === "IN_PROGRESS") {
      this.heartbeats.set(importId, new Date());
    }
  }

  async closeAbandonedImports(staleBefore: Date, limit = 100): Promise<number> {
    const stale = this.imports
      .filter(
        (entry) =>
          entry.status === "IN_PROGRESS" &&
          (this.heartbeats.get(entry.id) ?? new Date(entry.created_at)) <
            staleBefore,
      )
      .slice(0, limit);

    // The same choice as the real one: zero created is nothing to undo.
    for (const entry of stale) {
      this.closeAsInterrupted(
        entry,
        this.importedBy(entry) === 0
          ? "Importação interrompida: o servidor parou antes de terminar o arquivo e nenhuma entrega foi criada. Envie o arquivo de novo."
          : "Importação interrompida: o servidor parou antes de terminar o arquivo. Estorne esta importação e envie o arquivo de novo.",
      );
    }

    return stale.length;
  }

  async closeInterruptedImport(
    importId: string,
    businessId: string,
    stage: "not-started" | "stopped",
  ): Promise<boolean> {
    const found = this.findRecord(importId, businessId);

    if (found?.status !== "IN_PROGRESS") return false;

    const imported = this.importedBy(found);

    // The same choice as the real one: "nothing was created" only when true.
    this.closeAsInterrupted(
      found,
      stage === "not-started" && imported === 0
        ? "Importação não iniciada: o servidor reiniciou antes de processar o arquivo e nenhuma entrega foi criada. Envie o arquivo de novo."
        : "Importação interrompida pelo reinício do servidor antes de terminar o arquivo. Estorne esta importação e envie o arquivo de novo.",
    );

    return true;
  }

  private importedBy(entry: ImportRecord): number {
    return this.deliveries.filter(
      (delivery) =>
        delivery.importId === entry.id &&
        delivery.businessId === entry.businessId,
    ).length;
  }

  private closeAsInterrupted(entry: ImportRecord, message: string): void {
    const imported = this.importedBy(entry);

    entry.status = "COMPLETED";
    entry.imported = imported;
    entry.duplicated = 0;
    entry.invalid = 1;
    entry.report = {
      imported,
      duplicated: 0,
      invalid: 1,
      unknownHeaders: [],
      rows: [
        {
          line: 1,
          outcome: "invalid",
          recipient_name: null,
          reference: null,
          message,
        },
      ],
      routes: [],
    };
  }

  async findImportById(
    importId: string,
    businessId: string,
  ): Promise<ImportRecord | null> {
    return (
      this.imports.find(
        (entry) => entry.id === importId && entry.businessId === businessId,
      ) ?? null
    );
  }

  async listImports({
    businessId,
    page,
    pageSize,
    includeReport = false,
    sort,
    order,
    statuses,
    sources,
  }: ListImportsProps): Promise<ListImportsPage> {
    const base = this.imports.filter(
      (entry) => entry.businessId === businessId,
    );

    const key = sort ?? IMPORT_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : IMPORT_SORT_FALLBACK.order);

    const time = (value: Date | string) => new Date(value);

    // IMPORT_SORT, with its tiebreaker: created_at desc, then id desc.
    const filtered = base
      .filter(
        (entry) =>
          (!statuses?.length || statuses.includes(entry.status)) &&
          (!sources?.length || sources.includes(entry.source)),
      )
      .sort(
        (a, b) =>
          (key === "created_at"
            ? compareForOrder(time(a.created_at), time(b.created_at), direction)
            : compareForOrder(a[key], b[key], direction)) ||
          compareForOrder(time(a.created_at), time(b.created_at), "desc") ||
          compareForOrder(a.id, b.id, "desc"),
      );

    const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

    const groups = new Map<string, ImportGroup>();

    for (const entry of base) {
      const id = `${entry.status}|${entry.source}`;
      const group = groups.get(id) ?? {
        status: entry.status,
        source: entry.source,
        count: 0,
      };

      group.count += 1;
      groups.set(id, group);
    }

    return {
      // Like the real one: asked without reports, the rows have no key at
      // all, not an empty one.
      data: includeReport
        ? rows
        : rows.map(({ report: _report, ...summary }) => summary),
      groups: Array.from(groups.values()),
    };
  }

  async reverseImport(
    importId: string,
    businessId: string,
    onRemoved?: ReversalRemovedHook,
  ): Promise<ReversalResult> {
    return reverseWholeImport(this, importId, businessId, onRemoved);
  }

  async countImportDeliveries(
    importId: string,
    businessId: string,
  ): Promise<number> {
    return this.deliveries.filter(
      (delivery) =>
        delivery.importId === importId && delivery.businessId === businessId,
    ).length;
  }

  async claimReversal(
    importId: string,
    businessId: string,
    staleBefore: Date,
  ): Promise<ReversalClaim> {
    const record = this.findRecord(importId, businessId);

    if (!record) return { outcome: "not-found" };
    if (record.status === "REVERSED") return { outcome: "reversed" };
    if (record.status === "IN_PROGRESS") return { outcome: "in-progress" };

    // Like the real one: a lease with a fresh heartbeat is a live run; a
    // quiet one belongs to a dead run and is taken over.
    if (record.reversal_started_at && this.heartbeatOf(record) >= staleBefore) {
      return { outcome: "running", record };
    }

    // A new lease is never equal to the one it replaces, even within the
    // same millisecond: equality is what fences the old run out.
    const previous = record.reversal_started_at
      ? new Date(record.reversal_started_at).getTime()
      : 0;
    const lease = new Date(Math.max(Date.now(), previous + 1));

    record.reversal_started_at = lease;
    this.beat(record, lease);

    const progress =
      parseReversalProgress(record.reversal, lease) ??
      emptyReversalProgress(lease);

    record.reversal = progress;

    return { outcome: "claimed", lease, progress };
  }

  async touchReversal(
    importId: string,
    businessId: string,
    lease: Date,
  ): Promise<void> {
    const record = this.findRecord(importId, businessId);

    if (record?.status === "COMPLETED" && sameLease(record, lease)) {
      this.beat(record);
    }
  }

  async runReversal(
    importId: string,
    businessId: string,
    lease: Date,
    progress: ReversalProgress,
    {
      onRemoved,
      batchSize = REVERSAL_BATCH_SIZE,
    }: { onRemoved?: ReversalRemovedHook; batchSize?: number },
  ): Promise<ReversalResult> {
    let current = progress;

    try {
      if (!current.routesDone) {
        current = this.reverseRoutes(importId, businessId, lease, current);
      }

      for (;;) {
        const step = await this.reverseDeliveryBatch(
          importId,
          businessId,
          lease,
          current,
          { onRemoved, batchSize },
        );

        current = step.progress;

        if (step.done) return reversalResultOf(current);
      }
    } catch (error) {
      // Like the real one: our lease goes, the progress stays.
      await this.releaseReversal(importId, businessId, lease);

      throw error;
    }
  }

  async releaseReversal(
    importId: string,
    businessId: string,
    lease: Date,
  ): Promise<void> {
    const record = this.findRecord(importId, businessId);

    if (record && sameLease(record, lease)) record.reversal_started_at = null;
  }

  private findRecord(importId: string, businessId: string) {
    return this.imports.find(
      (entry) => entry.id === importId && entry.businessId === businessId,
    );
  }

  private heartbeatOf(record: ImportRecord): Date {
    return (
      this.heartbeats.get(record.id) ??
      new Date(record.updated_at ?? record.created_at)
    );
  }

  private beat(record: ImportRecord, at = new Date()): void {
    record.updated_at = at;
    this.heartbeats.set(record.id, at);
  }

  /** Each batch's first step, like the real one: still our lease? */
  private fence(
    importId: string,
    businessId: string,
    lease: Date,
  ): ImportRecord {
    const record = this.findRecord(importId, businessId);

    if (!record || record.status !== "COMPLETED" || !sameLease(record, lease)) {
      throw new ImportReversalLeaseLostError();
    }

    this.beat(record);

    return record;
  }

  /** The routes, once, against every delivery of the upload. */
  private reverseRoutes(
    importId: string,
    businessId: string,
    lease: Date,
    progress: ReversalProgress,
  ): ReversalProgress {
    const record = this.fence(importId, businessId, lease);

    const own = (entry: { importId: string | null; businessId: string }) =>
      entry.importId === importId && entry.businessId === businessId;

    const removable = new Set(
      this.deliveries
        .filter(own)
        .filter(
          (delivery) =>
            deliveryKeepReason({
              status: delivery.status,
              events: delivery.eventCount ?? 0,
              occurrences: delivery.occurrenceCount ?? 0,
            }) === null,
        )
        .map((delivery) => delivery.id),
    );

    const keptRoutes: ReversalResult["keptRoutes"] = [];
    const removableRouteIds = new Set<string>();

    for (const route of this.routes.filter(own).sort(byId)) {
      const reason = routeKeepReason({
        status: route.status,
        hasStopThatStays: route.stopDeliveryIds.some(
          (deliveryId) => !removable.has(deliveryId),
        ),
      });

      if (reason) {
        keptRoutes.push({ id: route.id, code: route.code, reason });
        continue;
      }

      removableRouteIds.add(route.id);
    }

    this.routes = this.routes.filter(
      (route) => !removableRouteIds.has(route.id),
    );

    // Whatever is kept stops claiming to be part of this upload.
    for (const route of this.routes.filter(own)) route.importId = null;

    const next: ReversalProgress = {
      ...progress,
      removedRoutes: progress.removedRoutes + removableRouteIds.size,
      keptRoutes: [...progress.keptRoutes, ...keptRoutes],
      routesDone: true,
    };

    record.reversal = next;

    return next;
  }

  /** The next `batchSize` deliveries still carrying the upload, in id order. */
  private async reverseDeliveryBatch(
    importId: string,
    businessId: string,
    lease: Date,
    progress: ReversalProgress,
    {
      onRemoved,
      batchSize,
    }: { onRemoved?: ReversalRemovedHook; batchSize: number },
  ): Promise<{ done: boolean; progress: ReversalProgress }> {
    const record = this.fence(importId, businessId, lease);

    const batch = this.deliveries
      .filter(
        (delivery) =>
          delivery.importId === importId && delivery.businessId === businessId,
      )
      .sort(byId)
      .slice(0, batchSize);

    const keptDeliveries: ReversalResult["keptDeliveries"] = [];
    const deletable = new Set<string>();

    for (const delivery of batch) {
      // The upload's routes that go are already gone: a route still holding
      // the delivery is one that stays.
      const onRouteThatStays = this.routes.some(
        (route) =>
          route.businessId === businessId &&
          route.stopDeliveryIds.includes(delivery.id),
      );

      const reason =
        deliveryKeepReason({
          status: delivery.status,
          events: delivery.eventCount ?? 0,
          occurrences: delivery.occurrenceCount ?? 0,
        }) ?? (onRouteThatStays ? KEEP_REASON.deliveryOnKeptRoute : null);

      if (reason) {
        keptDeliveries.push({
          id: delivery.id,
          recipient_name: delivery.recipient_name,
          reason,
        });

        continue;
      }

      deletable.add(delivery.id);
    }

    const removedRows = batch.filter((row) => deletable.has(row.id));

    // Announced before anything is applied, so a failing announcement leaves
    // the batch untouched — the transaction's rollback, mirrored.
    if (onRemoved && removedRows.length > 0) {
      await onRemoved(removedRows.map(removedDeliveryOf));
    }

    // The announcement awaited: a run that lost its lease meanwhile applies
    // nothing, as the real one's batch would roll back.
    if (!sameLease(record, lease)) throw new ImportReversalLeaseLostError();

    this.deliveries = this.deliveries.filter(
      (delivery) => !deletable.has(delivery.id),
    );

    // Whatever this batch kept stops claiming to be part of the upload.
    for (const delivery of batch) {
      if (!deletable.has(delivery.id)) delivery.importId = null;
    }

    const done = batch.length < batchSize;
    const now = new Date();

    const next: ReversalProgress = {
      ...progress,
      removedDeliveries: progress.removedDeliveries + removedRows.length,
      keptDeliveries: [...progress.keptDeliveries, ...keptDeliveries],
      finishedAt: done ? now.toISOString() : null,
    };

    record.reversal = next;

    if (done) {
      record.status = "REVERSED";
      record.reversed_at = now;
      record.reversal_started_at = null;
    }

    return { done, progress: next };
  }
}

/** The order the real one batches in (ORDER BY id). */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sameLease(record: ImportRecord, lease: Date): boolean {
  return (
    !!record.reversal_started_at &&
    new Date(record.reversal_started_at).getTime() === lease.getTime()
  );
}

export { InMemoryImportRepository };
export type { ReversibleDelivery, ReversibleRoute };
