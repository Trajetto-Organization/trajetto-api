import database from "@/../infra/database";

import type { IImportRepository } from "./IImport-repository";
import type {
  RemovedDelivery,
  CreateImportProps,
  FinishImportProps,
  ImportRecord,
  ImportReport,
  ImportSummary,
  ListImportsProps,
  ListImportsPage,
  ReversalResult,
} from "../dtos/import-dto";

import { Prisma } from "@prisma/client";

import { OPEN_STOP_STATUSES } from "@/shared/route/route-rules";

import { ImportAlreadyReversedError } from "../usecases/errors/import-errors";
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
      // What it did create, counted from the rows themselves: the report the
      // dead process was holding in memory died with it.
      const imported = await this.prisma.delivery.count({
        where: { importId: entry.id, businessId: entry.businessId },
      });

      const report: ImportReport = {
        ...EMPTY_REPORT,
        imported,
        invalid: 1,
        rows: [ABANDONED_ROW],
      };

      // The staleness is re-checked in the write: an upload whose heartbeat
      // came back between the read and here is alive, and is left alone.
      const done = await this.prisma.import.updateMany({
        where: {
          id: entry.id,
          status: "IN_PROGRESS",
          updated_at: { lt: staleBefore },
        },
        data: {
          status: "COMPLETED",
          imported,
          duplicated: 0,
          invalid: 1,
          report: report as unknown as Prisma.InputJsonValue,
        },
      });

      closed += done.count;
    }

    return closed;
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
    includeReport = true,
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
    onRemoved?: (
      removed: RemovedDelivery[],
      tx?: Prisma.TransactionClient,
    ) => Promise<void>,
  ): Promise<ReversalResult> {
    return this.prisma.$transaction(async (tx) => {
      // The claim comes first (IDEMP-13). Two clicks both passed the use
      // case's COMPLETED check; here the second one waits on the first's row
      // lock, re-reads the row as REVERSED, and matches nothing — instead of
      // "removing" the same deliveries again and reporting it.
      const claimed = await tx.import.updateMany({
        where: { id: importId, businessId, status: "COMPLETED" },
        data: { status: "REVERSED", reversed_at: new Date() },
      });

      if (claimed.count === 0) {
        const current = await tx.import.findFirst({
          where: { id: importId, businessId },
          select: { status: true },
        });

        if (current?.status === "REVERSED") {
          throw new ImportAlreadyReversedError();
        }

        // Another company's upload, or one still running: nothing is touched.
        return {
          removedDeliveries: 0,
          removedRoutes: 0,
          keptDeliveries: [],
          keptRoutes: [],
        };
      }

      const deliveries = await tx.delivery.findMany({
        where: { importId, businessId },
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
          _count: { select: { events: true, occurrences: true, stops: true } },
          // The open stops, and on which route: one on a route that is not
          // going away with this undo keeps its delivery (below).
          stops: {
            where: { status: { in: OPEN_STOP_STATUSES } },
            select: { routeId: true },
          },
        },
      });

      const keptDeliveries: ReversalResult["keptDeliveries"] = [];
      const removableDeliveryIds: string[] = [];

      for (const delivery of deliveries) {
        // Anything that happened to it means somebody worked it, and an undo
        // button must not be able to erase that.
        const reason =
          delivery.status !== "PENDING"
            ? "Já saiu do status pendente."
            : delivery._count.events > 0
              ? "Já tem registros do motorista."
              : delivery._count.occurrences > 0
                ? "Já tem ocorrência registrada."
                : null;

        if (reason) {
          keptDeliveries.push({
            id: delivery.id,
            recipient_name: delivery.recipient_name,
            reason,
          });

          continue;
        }

        removableDeliveryIds.push(delivery.id);
      }

      const routes = await tx.route.findMany({
        where: { importId, businessId },
        select: {
          id: true,
          code: true,
          status: true,
          stops: { select: { id: true, deliveryId: true, status: true } },
        },
      });

      const keptRoutes: ReversalResult["keptRoutes"] = [];
      const removableRouteIds: string[] = [];

      const removable = new Set(removableDeliveryIds);

      for (const route of routes) {
        const reason =
          route.status !== "PLANNED"
            ? "Já foi liberada ou já saiu."
            : // A route whose stops point at deliveries we are keeping would
              // become a route with holes in it. Keeping the whole route is
              // the honest outcome — the operator can cancel it.
              route.stops.some((stop) => !removable.has(stop.deliveryId))
              ? "Tem paradas de entregas que não puderam ser removidas."
              : null;

        if (reason) {
          keptRoutes.push({ id: route.id, code: route.code, reason });
          continue;
        }

        removableRouteIds.push(route.id);
      }

      // A delivery with an open stop on a route this undo is NOT removing — a
      // route built by hand in the panel, or one of the upload's that was
      // already released — stays. Deleting it would cascade its stop out of
      // that route, behind the dispatcher's back.
      const goingRoutes = new Set(removableRouteIds);
      const deletableDeliveryIds: string[] = [];

      for (const delivery of deliveries) {
        if (!removable.has(delivery.id)) continue;

        if (delivery.stops.some((stop) => !goingRoutes.has(stop.routeId))) {
          keptDeliveries.push({
            id: delivery.id,
            recipient_name: delivery.recipient_name,
            reason: "Está numa rota que não pode ser desfeita.",
          });

          continue;
        }

        deletableDeliveryIds.push(delivery.id);
      }

      // Routes first: a stop references its delivery, and the delivery cannot
      // go while a stop still points at it. The status is asked again in the
      // delete: the reads above take no lock, and a route released since is
      // not ours to remove any more.
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

      // Whatever is kept stops claiming to be part of this upload: the import
      // is being undone, and a row that survived it did so on its own merits.
      await tx.delivery.updateMany({
        where: { importId, businessId },
        data: { importId: null },
      });

      await tx.route.updateMany({
        where: { importId, businessId },
        data: { importId: null },
      });

      // The tenant is already guaranteed — these ids came out of a read
      // scoped by it — so this `businessId` changes no outcome and breaks
      // no test. It is here for the delete that somebody adds later from a
      // list they built differently, and it is the cheapest possible guard
      // on the one statement in this file that destroys rows. Do not remove
      // it on the grounds that the suite stays green.
      //
      // The removable criteria are repeated for the same reason as the
      // route's status: a delivery that was worked, or put on a route, between
      // the read and here is not deleted.
      const removedDeliveries =
        deletableDeliveryIds.length > 0
          ? await tx.delivery.deleteMany({
              where: {
                id: { in: deletableDeliveryIds },
                businessId,
                status: "PENDING",
                events: { none: {} },
                occurrences: { none: {} },
                stops: { none: { status: { in: OPEN_STOP_STATUSES } } },
              },
            })
          : { count: 0 };

      // Which ones actually went: the delete re-checks the criteria, so a
      // row worked in the meantime survived it and is not announced.
      if (onRemoved && removedDeliveries.count > 0) {
        const survivors = new Set(
          (
            await tx.delivery.findMany({
              where: { id: { in: deletableDeliveryIds }, businessId },
              select: { id: true },
            })
          ).map((row) => row.id),
        );

        await onRemoved(
          deliveries
            .filter(
              (row) =>
                deletableDeliveryIds.includes(row.id) && !survivors.has(row.id),
            )
            .map((row) => ({
              id: row.id,
              code: row.code,
              invoice_key: row.invoice_key,
              invoice_number: row.invoice_number,
              recipient_name: row.recipient_name,
              city: row.city,
              uf: row.uf,
            })),
          tx,
        );
      }

      // What was actually removed, from the deletes themselves.
      return {
        removedDeliveries: removedDeliveries.count,
        removedRoutes: removedRoutes.count,
        keptDeliveries,
        keptRoutes,
      };
    });
  }
}

export { ImportRepository };
export type { ImportReport };
