import database from "@/../infra/database";

import type {
  IImportRepository,
  ReversalRemovedHook,
} from "./IImport-repository";
import type {
  CreateImportProps,
  FinishImportProps,
  ImportRecord,
  ImportReport,
  ImportSummary,
  ListImportsProps,
  ListImportsPage,
  ReversalClaim,
  ReversalProgress,
  ReversalResult,
} from "../dtos/import-dto";

import { Prisma } from "@prisma/client";

import { OPEN_STOP_STATUSES } from "@/shared/route/route-rules";

import { ImportReversalLeaseLostError } from "../usecases/errors/import-errors";
import {
  KEEP_REASON,
  REVERSAL_BATCH_SIZE,
  REVERSAL_TRANSACTION_OPTIONS,
  deliveryKeepReason,
  emptyReversalProgress,
  parseReversalProgress,
  removedDeliveryOf,
  reverseWholeImport,
  reversalResultOf,
  routeKeepReason,
} from "../services/import-reversal";
import { resolveOrderBy } from "@/shared/pagination/list-query";
import {
  IMPORT_SORT,
  importListWhere,
} from "../usecases/list-imports/import-list";

/** What an upload's report says before it has processed anything. */
const EMPTY_REPORT: ImportReport = {
  imported: 0,
  duplicated: 0,
  invalid: 0,
  unknownHeaders: [],
  rows: [],
  routes: [],
};

/**
 * The one line the report of an abandoned upload carries.
 *
 * Line 1, where the parser puts sheet-level problems: this is about the file
 * as a whole, not about any row of it.
 */
const ABANDONED_ROW: ImportReport["rows"][number] = {
  line: 1,
  outcome: "invalid",
  recipient_name: null,
  reference: null,
  message:
    "Importação interrompida: o servidor parou antes de terminar o arquivo. " +
    "As entregas criadas até ali pertencem a esta importação e podem não ter " +
    "rota. Estorne esta importação e envie o arquivo de novo.",
};

/**
 * The same, for one that died before it created anything (still reading the
 * file, say): there is nothing to undo, and "estorne" sent the operator to
 * reverse an empty upload.
 */
const ABANDONED_EMPTY_ROW: ImportReport["rows"][number] = {
  line: 1,
  outcome: "invalid",
  recipient_name: null,
  reference: null,
  message:
    "Importação interrompida: o servidor parou antes de terminar o arquivo " +
    "e nenhuma entrega foi criada. Envie o arquivo de novo.",
};

/**
 * An upload handed back by a replica shutting down before it reached its
 * rows (import-queue.ts): it was waiting its turn or still reading the file,
 * and nothing was created.
 */
const NOT_STARTED_ROW: ImportReport["rows"][number] = {
  line: 1,
  outcome: "invalid",
  recipient_name: null,
  reference: null,
  message:
    "Importação não iniciada: o servidor reiniciou antes de processar o " +
    "arquivo e nenhuma entrega foi criada. Envie o arquivo de novo.",
};

/**
 * An upload handed back by a replica shutting down after it reached its
 * rows, when it did not stop at a row boundary in time to write its own
 * report. Even at zero deliveries counted: the row it is stuck on may still
 * commit after the count, and the undo is what takes that one back.
 */
const SHUTDOWN_ROW: ImportReport["rows"][number] = {
  line: 1,
  outcome: "invalid",
  recipient_name: null,
  reference: null,
  message:
    "Importação interrompida pelo reinício do servidor antes de terminar o " +
    "arquivo. As entregas criadas até ali pertencem a esta importação e " +
    "podem não ter rota. Estorne esta importação e envie o arquivo de novo.",
};

/** Every column of an upload but its report (Prisma 6.1 has no `omit`). */
const IMPORT_SUMMARY_COLUMNS = {
  id: true,
  source: true,
  status: true,
  filename: true,
  imported: true,
  duplicated: true,
  invalid: true,
  reversed_at: true,
  businessId: true,
  performedById: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.ImportSelect;

class ImportRepository implements IImportRepository {
  constructor(private prisma = database) {}

  async createImport(data: CreateImportProps): Promise<ImportRecord> {
    const created = await this.prisma.import.create({
      data: {
        source: data.source,
        status: "IN_PROGRESS",
        filename: data.filename,
        report: EMPTY_REPORT as unknown as Prisma.InputJsonValue,
        businessId: data.businessId,
        performedById: data.performedById,
      },
    });

    return created as unknown as ImportRecord;
  }

  async finishImport(
    importId: string,
    businessId: string,
    data: FinishImportProps,
  ): Promise<ImportRecord> {
    // updateMany, not update: the businessId belongs in the `where`, not in a
    // check above it. Only while still IN_PROGRESS: an upload the abandoned
    // sweep already closed, or that was reversed since, is not reopened.
    await this.prisma.import.updateMany({
      where: { id: importId, businessId, status: "IN_PROGRESS" },
      data: {
        status: "COMPLETED",
        imported: data.imported,
        duplicated: data.duplicated,
        invalid: data.invalid,
        report: data.report as unknown as Prisma.InputJsonValue,
      },
    });

    return this.prisma.import.findFirstOrThrow({
      where: { id: importId, businessId },
    }) as unknown as Promise<ImportRecord>;
  }

  async touchImport(importId: string, businessId: string): Promise<void> {
    await this.prisma.import.updateMany({
      where: { id: importId, businessId, status: "IN_PROGRESS" },
      data: { updated_at: new Date() },
    });
  }

  async closeAbandonedImports(staleBefore: Date, limit = 100): Promise<number> {
    // import_in_progress_heartbeat_idx: the uploads running right now. Raw,
    // with the status as a literal: Prisma binds it as a parameter, and a
    // generic plan over a parameter cannot prove the partial index.
    const stale = await this.prisma.$queryRaw<
      Array<{ id: string; businessId: string }>
    >`
      SELECT "id", "businessId"
      FROM "import"
      WHERE "status" = 'IN_PROGRESS'
        AND "updated_at" < ${staleBefore}
      ORDER BY "updated_at"
      LIMIT ${limit}::int
    `;

    let closed = 0;

    for (const entry of stale) {
      // The staleness is re-checked in the write: an upload whose heartbeat
      // came back between the read and here is alive, and is left alone.
      if (
        await this.closeAsInterrupted(entry.id, entry.businessId, {
          staleBefore,
          // Its process is gone: the count is final, and zero is nothing
          // to undo.
          row: (imported) =>
            imported === 0 ? ABANDONED_EMPTY_ROW : ABANDONED_ROW,
        })
      ) {
        closed += 1;
      }
    }

    return closed;
  }

  async closeInterruptedImport(
    importId: string,
    businessId: string,
    stage: "not-started" | "stopped",
  ): Promise<boolean> {
    return this.closeAsInterrupted(importId, businessId, {
      // "Nothing was created" only when it is true and will stay true: the
      // upload never reached its rows (its stop signal ends it before the
      // first one) and none are counted. A "not-started" upload that somehow
      // created rows is reported as the interrupted one it really is, and a
      // "stopped" one keeps SHUTDOWN_ROW even at zero (see there).
      row: (imported) =>
        stage === "not-started" && imported === 0
          ? NOT_STARTED_ROW
          : SHUTDOWN_ROW,
    });
  }

  /**
   * The one way an upload that will not finish is closed — by the sweep
   * after a crash, or by the shutdown hand-back — so both read the same:
   * COMPLETED, the deliveries it did create counted from the rows themselves
   * (the report a dead or stopping process held in memory is gone), and one
   * line saying why. Only while still IN_PROGRESS, and only when the
   * heartbeat is older than `staleBefore` if given. Answers whether it closed.
   */
  private async closeAsInterrupted(
    importId: string,
    businessId: string,
    {
      staleBefore,
      row,
    }: {
      staleBefore?: Date;
      row: (imported: number) => ImportReport["rows"][number];
    },
  ): Promise<boolean> {
    const imported = await this.prisma.delivery.count({
      where: { importId, businessId },
    });

    const report: ImportReport = {
      ...EMPTY_REPORT,
      imported,
      invalid: 1,
      rows: [row(imported)],
    };

    const done = await this.prisma.import.updateMany({
      where: {
        id: importId,
        businessId,
        status: "IN_PROGRESS",
        ...(staleBefore && { updated_at: { lt: staleBefore } }),
      },
      data: {
        status: "COMPLETED",
        imported,
        duplicated: 0,
        invalid: 1,
        report: report as unknown as Prisma.InputJsonValue,
      },
    });

    return done.count === 1;
  }

  async findImportById(
    importId: string,
    businessId: string,
  ): Promise<ImportRecord | null> {
    const found = await this.prisma.import.findFirst({
      where: { id: importId, businessId },
    });

    return found as unknown as ImportRecord | null;
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
    const filters = { businessId, statuses, sources };

    // The page and one GROUP BY (at most six rows) that yields the pager
    // total and both filters' counts: the screen's two connections.
    const [data, grouped] = await Promise.all([
      this.prisma.import.findMany({
        where: importListWhere(filters, { withFacets: true }),
        orderBy: resolveOrderBy(IMPORT_SORT, { sort, order }),
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Without the report, the columns are named one by one: a report is
        // one JSON entry per spreadsheet line, and a page of big days read
        // them all out of TOAST to draw four numbers per row.
        ...(!includeReport && { select: IMPORT_SUMMARY_COLUMNS }),
      }),
      this.prisma.import.groupBy({
        by: ["status", "source"],
        where: importListWhere(filters, { withFacets: false }),
        _count: { _all: true },
      }),
    ]);

    return {
      data: data as unknown as ImportSummary[],
      groups: grouped.map((group) => ({
        status: group.status,
        source: group.source,
        count: group._count._all,
      })),
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
    return this.prisma.delivery.count({ where: { importId, businessId } });
  }

  async claimReversal(
    importId: string,
    businessId: string,
    staleBefore: Date,
  ): Promise<ReversalClaim> {
    const lease = new Date();

    // The conditional UPDATE is the lock (IDEMP-13): of two clicks racing,
    // the second waits on the first's row lock, re-reads the row with the
    // lease taken and a fresh heartbeat, and matches nothing. A lease whose
    // heartbeat went quiet belongs to a dead run and is taken over.
    const claimed = await this.prisma.import.updateMany({
      where: {
        id: importId,
        businessId,
        status: "COMPLETED",
        OR: [
          { reversal_started_at: null },
          { updated_at: { lt: staleBefore } },
        ],
      },
      data: { reversal_started_at: lease, updated_at: lease },
    });

    const record = (await this.prisma.import.findFirst({
      where: { id: importId, businessId },
    })) as unknown as ImportRecord | null;

    if (claimed.count === 0) {
      if (!record) return { outcome: "not-found" };
      if (record.status === "REVERSED") return { outcome: "reversed" };
      if (record.status === "IN_PROGRESS") return { outcome: "in-progress" };

      return { outcome: "running", record };
    }

    const resumed = parseReversalProgress(record?.reversal, lease);

    if (resumed) return { outcome: "claimed", lease, progress: resumed };

    // First attempt: the progress starts at zero, written under the lease.
    const progress = emptyReversalProgress(lease);

    await this.prisma.import.updateMany({
      where: { id: importId, businessId, reversal_started_at: lease },
      data: { reversal: progress as unknown as Prisma.InputJsonValue },
    });

    return { outcome: "claimed", lease, progress };
  }

  async touchReversal(
    importId: string,
    businessId: string,
    lease: Date,
  ): Promise<void> {
    await this.prisma.import.updateMany({
      where: {
        id: importId,
        businessId,
        status: "COMPLETED",
        reversal_started_at: lease,
      },
      data: { updated_at: new Date() },
    });
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
        current = await this.prisma.$transaction(
          (tx) => this.reverseRoutes(tx, importId, businessId, lease, current),
          REVERSAL_TRANSACTION_OPTIONS,
        );
      }

      for (;;) {
        const step = await this.prisma.$transaction(
          (tx) =>
            this.reverseDeliveryBatch(
              tx,
              importId,
              businessId,
              lease,
              current,
              {
                onRemoved,
                batchSize,
              },
            ),
          REVERSAL_TRANSACTION_OPTIONS,
        );

        current = step.progress;

        if (step.done) return reversalResultOf(current);
      }
    } catch (error) {
      // The lease goes, the progress stays: the committed batches are
      // counted on the record, and the retry resumes at once instead of
      // waiting for the heartbeat to go stale.
      await this.releaseReversal(importId, businessId, lease).catch(
        () => undefined,
      );

      throw error;
    }
  }

  async releaseReversal(
    importId: string,
    businessId: string,
    lease: Date,
  ): Promise<void> {
    // Only OUR lease: a run that lost it to another must not release the
    // other's. A run still going on this lease fails its next batch, which
    // re-checks the lease before it deletes anything.
    await this.prisma.import.updateMany({
      where: { id: importId, businessId, reversal_started_at: lease },
      data: { reversal_started_at: null },
    });
  }

  /**
   * Every batch starts here: the heartbeat, written only while the lease is
   * still this run's. It also locks the record's row for the rest of the
   * batch, so a takeover waits for the batch to commit — and a run that lost
   * its lease rolls its batch back before it deletes or announces anything.
   */
  private async fence(
    tx: Prisma.TransactionClient,
    importId: string,
    businessId: string,
    lease: Date,
  ): Promise<void> {
    const held = await tx.import.updateMany({
      where: {
        id: importId,
        businessId,
        status: "COMPLETED",
        reversal_started_at: lease,
      },
      data: { updated_at: new Date() },
    });

    if (held.count !== 1) throw new ImportReversalLeaseLostError();
  }

  private async saveProgress(
    tx: Prisma.TransactionClient,
    importId: string,
    businessId: string,
    progress: ReversalProgress,
  ): Promise<void> {
    await tx.import.updateMany({
      where: { id: importId, businessId },
      data: { reversal: progress as unknown as Prisma.InputJsonValue },
    });
  }

  /**
   * The routes, decided once and before any delivery, against EVERY delivery
   * of the upload: a route goes only if it is still PLANNED and every stop on
   * it is a delivery of this upload that can go. Deciding per batch would
   * see a fraction of its stops.
   */
  private async reverseRoutes(
    tx: Prisma.TransactionClient,
    importId: string,
    businessId: string,
    lease: Date,
    progress: ReversalProgress,
  ): Promise<ReversalProgress> {
    await this.fence(tx, importId, businessId, lease);

    const routes = await tx.route.findMany({
      where: { importId, businessId },
      select: { id: true, code: true, status: true },
      orderBy: { id: "asc" },
    });

    // The routes with a stop whose delivery stays: not this upload's, or
    // worked. In SQL, over every stop at once, instead of loading 20,000
    // stops and their deliveries into memory.
    const withStopThatStays =
      routes.length === 0
        ? new Set<string>()
        : new Set(
            (
              await tx.route.findMany({
                where: {
                  importId,
                  businessId,
                  stops: {
                    some: {
                      delivery: {
                        OR: [
                          { importId: null },
                          { importId: { not: importId } },
                          { businessId: { not: businessId } },
                          { status: { not: "PENDING" } },
                          { events: { some: {} } },
                          { occurrences: { some: {} } },
                        ],
                      },
                    },
                  },
                },
                select: { id: true },
              })
            ).map((route) => route.id),
          );

    const keptRoutes: ReversalResult["keptRoutes"] = [];
    const removableRouteIds: string[] = [];

    for (const route of routes) {
      const reason = routeKeepReason({
        status: route.status,
        hasStopThatStays: withStopThatStays.has(route.id),
      });

      if (reason) {
        keptRoutes.push({ id: route.id, code: route.code, reason });
        continue;
      }

      removableRouteIds.push(route.id);
    }

    // Routes before their deliveries: a stop references its delivery, and
    // the delivery cannot go while a stop still points at it. The status is
    // asked again in the delete: the reads above take no lock, and a route
    // released since is not ours to remove any more.
    const removedRoutes =
      removableRouteIds.length > 0
        ? await tx.route.deleteMany({
            where: {
              id: { in: removableRouteIds },
              businessId,
              status: "PLANNED",
            },
          })
        : { count: 0 };

    // Whatever is kept stops claiming to be part of this upload.
    await tx.route.updateMany({
      where: { importId, businessId },
      data: { importId: null },
    });

    const next: ReversalProgress = {
      ...progress,
      removedRoutes: progress.removedRoutes + removedRoutes.count,
      keptRoutes: [...progress.keptRoutes, ...keptRoutes],
      routesDone: true,
    };

    await this.saveProgress(tx, importId, businessId, next);

    return next;
  }

  /**
   * The next `batchSize` deliveries still carrying the upload's id, in id
   * order. Each one leaves the batch removed or cut loose, so the next batch
   * — or the retry after a crash — is simply the next ones still carrying it.
   * The last batch flips the upload to REVERSED and drops the lease.
   */
  private async reverseDeliveryBatch(
    tx: Prisma.TransactionClient,
    importId: string,
    businessId: string,
    lease: Date,
    progress: ReversalProgress,
    {
      onRemoved,
      batchSize,
    }: { onRemoved?: ReversalRemovedHook; batchSize: number },
  ): Promise<{ done: boolean; progress: ReversalProgress }> {
    await this.fence(tx, importId, businessId, lease);

    const batch = await tx.delivery.findMany({
      where: { importId, businessId },
      orderBy: { id: "asc" },
      take: batchSize,
      select: {
        id: true,
        recipient_name: true,
        status: true,
        // What the webhook of a removed delivery carries.
        code: true,
        invoice_key: true,
        invoice_number: true,
        city: true,
        uf: true,
        _count: { select: { events: true, occurrences: true } },
        // The open stops left. The upload's routes that go are already gone
        // (reverseRoutes), so an open stop here is on a route that stays — a
        // route built by hand in the panel, or one of the upload's that was
        // kept — and deleting the delivery would cascade the stop out of it,
        // behind the dispatcher's back.
        stops: {
          where: { status: { in: OPEN_STOP_STATUSES } },
          select: { routeId: true },
        },
      },
    });

    const keptDeliveries: ReversalResult["keptDeliveries"] = [];
    const deletableIds: string[] = [];

    for (const delivery of batch) {
      const reason =
        deliveryKeepReason({
          status: delivery.status,
          events: delivery._count.events,
          occurrences: delivery._count.occurrences,
        }) ??
        (delivery.stops.length > 0 ? KEEP_REASON.deliveryOnKeptRoute : null);

      if (reason) {
        keptDeliveries.push({
          id: delivery.id,
          recipient_name: delivery.recipient_name,
          reason,
        });

        continue;
      }

      deletableIds.push(delivery.id);
    }

    // The tenant is already guaranteed — these ids came out of a read scoped
    // by it — so this `businessId` changes no outcome and breaks no test. It
    // is here for the delete that somebody adds later from a list they built
    // differently, and it is the cheapest possible guard on the one statement
    // in this file that destroys rows. Do not remove it on the grounds that
    // the suite stays green.
    //
    // The removable criteria are repeated for the same reason as the route's
    // status: a delivery that was worked, or put on a route, between the read
    // and here is not deleted.
    const removedDeliveries =
      deletableIds.length > 0
        ? await tx.delivery.deleteMany({
            where: {
              id: { in: deletableIds },
              businessId,
              status: "PENDING",
              events: { none: {} },
              occurrences: { none: {} },
              stops: { none: { status: { in: OPEN_STOP_STATUSES } } },
            },
          })
        : { count: 0 };

    // Whatever this batch kept stops claiming to be part of the upload: it
    // survived the undo on its own merits, and the next batch must not read
    // it again.
    if (batch.length > 0) {
      await tx.delivery.updateMany({
        where: { id: { in: batch.map((row) => row.id) }, importId, businessId },
        data: { importId: null },
      });
    }

    // Which ones actually went: the delete re-checks the criteria, so a row
    // worked in the meantime survived it and is not announced.
    if (onRemoved && removedDeliveries.count > 0) {
      const survivors = new Set(
        (
          await tx.delivery.findMany({
            where: { id: { in: deletableIds }, businessId },
            select: { id: true },
          })
        ).map((row) => row.id),
      );

      const deletable = new Set(deletableIds);

      await onRemoved(
        batch
          .filter((row) => deletable.has(row.id) && !survivors.has(row.id))
          .map(removedDeliveryOf),
        tx,
      );
    }

    const done = batch.length < batchSize;
    const now = new Date();

    const next: ReversalProgress = {
      ...progress,
      removedDeliveries: progress.removedDeliveries + removedDeliveries.count,
      keptDeliveries: [...progress.keptDeliveries, ...keptDeliveries],
      finishedAt: done ? now.toISOString() : null,
    };

    if (!done) {
      await this.saveProgress(tx, importId, businessId, next);

      return { done, progress: next };
    }

    // The last batch: REVERSED only now, so the status never says "undone"
    // about an upload that still has rows to undo.
    await tx.import.updateMany({
      where: {
        id: importId,
        businessId,
        status: "COMPLETED",
        reversal_started_at: lease,
      },
      data: {
        status: "REVERSED",
        reversed_at: now,
        reversal_started_at: null,
        reversal: next as unknown as Prisma.InputJsonValue,
      },
    });

    return { done, progress: next };
  }
}

export { ImportRepository };
export type { ImportReport };
