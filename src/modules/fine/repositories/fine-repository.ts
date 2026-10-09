import database from "@/../infra/database";
import { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

import {
  Fine,
  NewFine,
  FineExportRow,
  FineListQuery,
  ListFinesQuery,
  ListFinesResult,
  UpdateFine,
} from "../dtos/fine-dto";

import { IFineRepository } from "./IFine-repository";

import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  FINE_SORT,
  FINE_STATUSES,
  fineListWhere,
  fineStatus,
  fineStatusWhere,
  fullViolationCode,
  labelIdsOf,
  type FineListGroup,
  type FineStatus,
} from "../usecases/list-fine/fine-list";

/** What a fine carries to the screens: names instead of ids. */
const FINE_INCLUDE = {
  branch: { select: { corporate_reason: true } },
  driver: { select: { name: true, cpf: true } },
  vehicle: { select: { license_plate: true, description: true } },
  trafficViolationCode: {
    select: {
      code: true,
      sub_code: true,
      description: true,
      gravity: true,
      points: true,
    },
  },
} satisfies Prisma.FineInclude;

const EXPORT_BATCH_SIZE = 1000;

class FineRepository implements IFineRepository {
  constructor(private prisma = database) {}

  // `tx` lets the use case create the fine and its outbox event atomically.
  async createFine(
    fineData: NewFine,
    tx?: Prisma.TransactionClient,
  ): Promise<Fine> {
    const client = tx ?? this.prisma;

    const fineCreated = await client.fine.create({
      data: {
        violation_date: fineData.violation_date,
        due_date: fineData.due_date,
        payment_date: fineData.payment_date,
        amount: fineData.amount,
        points: fineData.points,
        location: fineData.location,
        latitude: fineData.latitude,
        longitude: fineData.longitude,
        latitude_original: fineData.latitude_original,
        longitude_original: fineData.longitude_original,
        // The origin and the location audit used to be computed by the use
        // case and dropped here: every fine was saved as WEB_DASHBOARD with
        // no location source nor editor.
        location_source: fineData.location_source,
        location_edited_by: fineData.location_edited_by,
        location_edited_at: fineData.location_edited_at,
        created_from: fineData.created_from,
        observation: fineData.observation,
        client_submission_id: fineData.client_submission_id ?? null,
        business: {
          connect: { id: fineData.businessId },
        },
        branch: {
          connect: { id: fineData.branchId },
        },
        driver: {
          connect: { id: fineData.driverId },
        },
        vehicle: {
          connect: { id: fineData.vehicleId },
        },
        trafficViolationCode: {
          connect: { id: fineData.trafficViolationCodeId },
        },
      },
      include: FINE_INCLUDE,
    });

    return fineCreated;
  }

  async findFineBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<Fine | null> {
    // The unique (businessId, client_submission_id) index answers this.
    return this.prisma.fine.findUnique({
      where: {
        businessId_client_submission_id: {
          businessId,
          client_submission_id: clientSubmissionId,
        },
      },
      include: FINE_INCLUDE,
    });
  }

  async listFines({
    page,
    pageSize,
    sort,
    order,
    todayStart,
    ...filters
  }: ListFinesQuery): Promise<ListFinesResult> {
    const base = fineListWhere(filters, { withFacets: false, todayStart });

    // Two connections at most (the screen's budget): the page on one, the
    // three status GROUP BYs one after the other on the second. Each status
    // is a disjoint condition, so the groups add up to the base exactly.
    const [data, groups] = await Promise.all([
      this.prisma.fine.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: fineListWhere(filters, { withFacets: true, todayStart }),
        orderBy: resolveOrderBy(FINE_SORT, { sort, order }),
        include: FINE_INCLUDE,
      }),
      this.groupByStatus(base, todayStart),
    ]);

    const ids = labelIdsOf(groups, filters);

    // `businessId` in the branch lookup: an id of another company typed into
    // the URL gets no name back. Codes are the national table, the same for
    // every company.
    const [branches, codes] = await Promise.all([
      ids.branchId.length
        ? this.prisma.branch.findMany({
            where: { businessId: filters.businessId, id: { in: ids.branchId } },
            select: { id: true, corporate_reason: true },
          })
        : Promise.resolve([]),
      ids.trafficViolationCodeId.length
        ? this.prisma.trafficViolationCode.findMany({
            where: { id: { in: ids.trafficViolationCodeId } },
            select: { id: true, code: true, sub_code: true },
          })
        : Promise.resolve([]),
    ]);

    return {
      data: data.map((fine) => ({ ...fine, status: fineStatus(fine, todayStart) })),
      groups,
      labels: {
        branchId: Object.fromEntries(
          branches.map((branch) => [branch.id, branch.corporate_reason]),
        ),
        trafficViolationCodeId: Object.fromEntries(
          codes.map((code) => [code.id, fullViolationCode(code)]),
        ),
      },
    };
  }

  private async groupByStatus(
    base: Prisma.FineWhereInput,
    todayStart: Date,
  ): Promise<FineListGroup[]> {
    const groups: FineListGroup[] = [];

    for (const status of FINE_STATUSES) {
      const rows = await this.prisma.fine.groupBy({
        by: ["branchId", "trafficViolationCodeId"],
        where: { AND: [base, fineStatusWhere(status, todayStart)] },
        _count: { _all: true },
        _sum: { amount: true },
      });

      for (const row of rows) {
        groups.push({
          status,
          branchId: row.branchId,
          trafficViolationCodeId: row.trafficViolationCodeId,
          count: row._count._all,
          amount: (row._sum.amount ?? new Decimal(0)).toString(),
        });
      }
    }

    return groups;
  }

  async countFinesForExport({
    todayStart,
    sort: _sort,
    order: _order,
    ...filters
  }: FineListQuery): Promise<number> {
    return this.prisma.fine.count({
      where: fineListWhere(filters, { withFacets: true, todayStart }),
    });
  }

  /**
   * The rows of the list's search and filters, newest first, in batches.
   * Keyset on (created_at, id): the export does not follow the column the
   * screen is sorted by, because a cursor over a nullable or related column
   * is not a stable position.
   */
  async *streamFinesForExport({
    todayStart,
    sort: _sort,
    order: _order,
    ...filters
  }: FineListQuery): AsyncGenerator<FineExportRow> {
    const where = fineListWhere(filters, { withFacets: true, todayStart });

    let cursor: string | undefined = undefined;

    while (true) {
      const fines: Array<
        Prisma.FineGetPayload<{ include: typeof FINE_INCLUDE }>
      > = await this.prisma.fine.findMany({
        where,
        include: FINE_INCLUDE,
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: EXPORT_BATCH_SIZE,
        ...(cursor && { skip: 1, cursor: { id: cursor } }),
      });

      if (fines.length === 0) break;

      for (const fine of fines) {
        yield {
          id: fine.id,
          violation_date: fine.violation_date,
          due_date: fine.due_date,
          payment_date: fine.payment_date,
          status: fineStatus(fine, todayStart) as FineStatus,
          amount: fine.amount.toNumber(),
          points: fine.points,
          location: fine.location,
          observation: fine.observation,
          branchName: fine.branch.corporate_reason,
          driverName: fine.driver.name,
          driverCpf: fine.driver.cpf,
          vehicleLicensePlate: fine.vehicle.license_plate,
          vehicleDescription: fine.vehicle.description,
          violationCode: fullViolationCode(fine.trafficViolationCode),
          violationDescription: fine.trafficViolationCode.description,
          latitude: fine.latitude,
          longitude: fine.longitude,
          created_at: fine.created_at,
          updated_at: fine.updated_at,
        };
      }

      if (fines.length < EXPORT_BATCH_SIZE) break;

      cursor = fines[fines.length - 1].id;
    }
  }

  async updateFine({ fineData, fineId, businessId }: UpdateFine): Promise<Fine> {
    const filteredData = Object.fromEntries(
      Object.entries(fineData).filter(([, value]) => value !== undefined),
    );

    // `updateMany` with the tenant in the `where` (the use case already
    // checked): a fine of another company is never written, whatever path
    // reaches here. The row is read back for the caller.
    const { count } = await this.prisma.fine.updateMany({
      where: { id: fineId, businessId },
      data: filteredData,
    });

    if (count === 0) {
      throw new Error("Fine not found in this company.");
    }

    return this.prisma.fine.findUniqueOrThrow({
      where: { id: fineId },
      include: FINE_INCLUDE,
    });
  }

  async deleteFine(fineId: string, businessId: string): Promise<Fine> {
    // `businessId` in the `where`, duplicating the use case's check: the use
    // case protects the path someone remembered, the `where` the ones nobody
    // thought of. `deleteMany` because a foreign fine is a legitimate absence
    // here, not a P2025.
    const found = await this.prisma.fine.findFirst({
      where: { id: fineId, businessId },
    });

    if (!found) {
      throw new Error("Fine not found in this company.");
    }

    await this.prisma.fine.deleteMany({ where: { id: fineId, businessId } });

    return found;
  }

  async findFineById(fineId: string): Promise<Fine | null> {
    return this.prisma.fine.findUnique({
      where: { id: fineId },
      include: FINE_INCLUDE,
    });
  }

  async countFinesByDriverId(driverId: string): Promise<number> {
    return this.prisma.fine.count({ where: { driverId } });
  }
}

export { FineRepository, FINE_INCLUDE };
