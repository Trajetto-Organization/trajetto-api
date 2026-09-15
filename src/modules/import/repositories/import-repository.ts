import database from "@/../infra/database";

import type { IImportRepository } from "./IImport-repository";
import type {
  CreateImportProps,
  FinishImportProps,
  ImportRecord,
  ImportReport,
  ListImportsProps,
  ListImportsResult,
  ReversalResult,
} from "../dtos/import-dto";

import { Prisma } from "@prisma/client";

/** What an upload's report says before it has processed anything. */
const EMPTY_REPORT: ImportReport = {
  imported: 0,
  duplicated: 0,
  invalid: 0,
  unknownHeaders: [],
  rows: [],
  routes: [],
};

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
    // check above it.
    await this.prisma.import.updateMany({
      where: { id: importId, businessId },
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
  }: ListImportsProps): Promise<ListImportsResult> {
    const [data, total] = await Promise.all([
      this.prisma.import.findMany({
        where: { businessId },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.import.count({ where: { businessId } }),
    ]);

    return { data: data as unknown as ImportRecord[], total };
  }

  async reverseImport(
    importId: string,
    businessId: string,
  ): Promise<ReversalResult> {
    return this.prisma.$transaction(async (tx) => {
      const deliveries = await tx.delivery.findMany({
        where: { importId, businessId },
        select: {
          id: true,
          recipient_name: true,
          status: true,
          _count: { select: { events: true, occurrences: true, stops: true } },
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

      // Routes first: a stop references its delivery, and the delivery cannot
      // go while a stop still points at it.
      if (removableRouteIds.length > 0) {
        await tx.route.deleteMany({
          where: { id: { in: removableRouteIds }, businessId },
        });
      }

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

      if (removableDeliveryIds.length > 0) {
        // The tenant is already guaranteed — these ids came out of a read
        // scoped by it — so this `businessId` changes no outcome and breaks
        // no test. It is here for the delete that somebody adds later from a
        // list they built differently, and it is the cheapest possible guard
        // on the one statement in this file that destroys rows. Do not remove
        // it on the grounds that the suite stays green.
        await tx.delivery.deleteMany({
          where: { id: { in: removableDeliveryIds }, businessId },
        });
      }

      await tx.import.updateMany({
        where: { id: importId, businessId, status: "COMPLETED" },
        data: { status: "REVERSED", reversed_at: new Date() },
      });

      return {
        removedDeliveries: removableDeliveryIds.length,
        removedRoutes: removableRouteIds.length,
        keptDeliveries,
        keptRoutes,
      };
    });
  }
}

export { ImportRepository };
export type { ImportReport };
