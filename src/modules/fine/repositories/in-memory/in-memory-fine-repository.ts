import { v7 as uuidV7 } from "uuid";

import { Decimal } from "@prisma/client/runtime/library";
import { IFineRepository } from "../IFine-repository";

import {
  Fine,
  NewFine,
  FineExportRow,
  FineListQuery,
  ListFinesQuery,
  ListFinesResult,
  UpdateFine,
} from "../../dtos/fine-dto";

import {
  FINE_SORT_FALLBACK,
  fineStatus,
  fullViolationCode,
  labelIdsOf,
  selectedStatuses,
  type FineListFilters,
  type FineListGroup,
  type FineSortKey,
} from "../../usecases/list-fine/fine-list";

interface BranchRow {
  businessId: string;
  corporate_reason: string;
}

interface DriverRow {
  name: string;
  cpf: string;
}

interface VehicleRow {
  license_plate: string;
  description: string;
}

interface CodeRow {
  code: string;
  sub_code: number;
  description: string;
  gravity: string;
  points: number;
}

type ListedFine = Fine & {
  branch: { corporate_reason: string };
  driver: DriverRow;
  vehicle: VehicleRow;
  trafficViolationCode: CodeRow;
};

// Same shapes as fine-list.ts, which the Prisma side reads as a `where`.
const FULL_CODE = /^(\d{1,6})-(\d{1,4})$/;
const MONEY = /^\d{1,8}(?:[.,]\d{1,2})?$/;

/**
 * The fines table in memory, with the semantics of FineRepository: the
 * tenant in every read and write, the list's search as a literal
 * case-insensitive substring over the same columns and joins, the facets,
 * the same order with the same tiebreaker, paging after sorting, the status
 * groups the cards come from, and `null` clearing a column on update.
 *
 * The joined rows (branch, driver, vehicle, code) are seeded by tests
 * through the public maps, so search, sort and labels behave as over
 * Postgres.
 */
class InMemoryFineRepository implements IFineRepository {
  public fines: Fine[] = [];

  public branches = new Map<string, BranchRow>();
  public drivers = new Map<string, DriverRow>();
  public vehicles = new Map<string, VehicleRow>();
  public codes = new Map<string, CodeRow>();

  /** (businessId:key) → id, the unique index of the real table. */
  private submissions = new Map<string, string>();

  async createFine(fineData: NewFine): Promise<Fine> {
    const now = new Date();

    const newFine: Fine = {
      id: uuidV7(),
      violation_date: new Date(fineData.violation_date),
      due_date: new Date(fineData.due_date),
      payment_date: fineData.payment_date
        ? new Date(fineData.payment_date)
        : null,
      amount: new Decimal(fineData.amount),
      points: fineData.points,
      location: fineData.location ?? null,
      observation: fineData.observation ?? null,
      businessId: fineData.businessId,
      branchId: fineData.branchId,
      driverId: fineData.driverId,
      vehicleId: fineData.vehicleId,
      trafficViolationCodeId: fineData.trafficViolationCodeId,
      latitude: fineData.latitude ?? null,
      longitude: fineData.longitude ?? null,
      latitude_original: fineData.latitude_original ?? null,
      longitude_original: fineData.longitude_original ?? null,
      location_source: fineData.location_source ?? null,
      location_edited_by: fineData.location_edited_by ?? null,
      location_edited_at: fineData.location_edited_at ?? null,
      created_from: fineData.created_from,
      // The column Prisma returns, null when the client sent no key.
      client_submission_id: fineData.client_submission_id ?? null,
      created_at: now,
      updated_at: now,
    };

    this.fines.push(newFine);

    if (fineData.client_submission_id) {
      this.submissions.set(
        `${fineData.businessId}:${fineData.client_submission_id}`,
        newFine.id,
      );
    }

    return this.withRelations(newFine);
  }

  async findFineBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<Fine | null> {
    const id = this.submissions.get(`${businessId}:${clientSubmissionId}`);
    const fine = this.fines.find((row) => row.id === id);

    return fine ? this.withRelations(fine) : null;
  }

  async listFines({
    page,
    pageSize,
    sort,
    order,
    todayStart,
    ...filters
  }: ListFinesQuery): Promise<ListFinesResult> {
    const base = this.fines.filter((fine) => this.matchesBase(fine, filters));

    const rows = base
      .filter((fine) => this.matchesFacets(fine, filters, todayStart))
      .sort(this.comparator(sort, order));

    const groups = new Map<string, FineListGroup>();

    for (const fine of base) {
      const status = fineStatus(fine, todayStart);
      const key = [status, fine.branchId, fine.trafficViolationCodeId].join(
        "|",
      );

      const group = groups.get(key) ?? {
        status,
        branchId: fine.branchId,
        trafficViolationCodeId: fine.trafficViolationCodeId,
        count: 0,
        amount: "0",
      };

      group.count += 1;
      group.amount = new Decimal(group.amount)
        .plus(new Decimal(fine.amount.toString()))
        .toString();

      groups.set(key, group);
    }

    const groupList = Array.from(groups.values());
    const ids = labelIdsOf(groupList, filters);

    const skip = (page - 1) * pageSize;

    return {
      data: rows.slice(skip, skip + pageSize).map((fine) => ({
        ...this.withRelations(fine),
        status: fineStatus(fine, todayStart),
      })),
      groups: groupList,
      labels: {
        // Only the company's own branches are named, like the Prisma lookup.
        branchId: Object.fromEntries(
          ids.branchId.flatMap((id) => {
            const branch = this.branches.get(id);

            return branch && branch.businessId === filters.businessId
              ? [[id, branch.corporate_reason]]
              : [];
          }),
        ),
        trafficViolationCodeId: Object.fromEntries(
          ids.trafficViolationCodeId.flatMap((id) => {
            const code = this.codes.get(id);

            return code ? [[id, fullViolationCode(code)]] : [];
          }),
        ),
      },
    };
  }

  async countFinesForExport({
    todayStart,
    sort: _sort,
    order: _order,
    ...filters
  }: FineListQuery): Promise<number> {
    return this.fines.filter(
      (fine) =>
        this.matchesBase(fine, filters) &&
        this.matchesFacets(fine, filters, todayStart),
    ).length;
  }

  async *streamFinesForExport({
    todayStart,
    sort: _sort,
    order: _order,
    ...filters
  }: FineListQuery): AsyncGenerator<FineExportRow> {
    const rows = this.fines
      .filter(
        (fine) =>
          this.matchesBase(fine, filters) &&
          this.matchesFacets(fine, filters, todayStart),
      )
      // Newest first, like the repository's keyset.
      .sort(this.comparator(undefined, undefined));

    for (const fine of rows) {
      const row = this.withRelations(fine);

      yield {
        id: fine.id,
        violation_date: new Date(fine.violation_date),
        due_date: new Date(fine.due_date),
        payment_date: fine.payment_date ? new Date(fine.payment_date) : null,
        status: fineStatus(fine, todayStart),
        amount: Number(fine.amount),
        points: fine.points,
        location: fine.location ?? null,
        observation: fine.observation ?? null,
        branchName: row.branch.corporate_reason,
        driverName: row.driver.name,
        driverCpf: row.driver.cpf,
        vehicleLicensePlate: row.vehicle.license_plate,
        vehicleDescription: row.vehicle.description,
        violationCode: fullViolationCode(row.trafficViolationCode),
        violationDescription: row.trafficViolationCode.description,
        latitude: fine.latitude ?? null,
        longitude: fine.longitude ?? null,
        created_at: new Date(fine.created_at),
        updated_at: new Date(fine.updated_at),
      };
    }
  }

  async updateFine({
    fineData,
    fineId,
    businessId,
  }: UpdateFine): Promise<Fine> {
    const index = this.fines.findIndex(
      (fine) => fine.id === fineId && fine.businessId === businessId,
    );

    if (index === -1) {
      throw new Error("Fine not found in this company.");
    }

    // Undefined is "not sent"; null clears the column, as Prisma writes it.
    const changes = Object.fromEntries(
      Object.entries(fineData).filter(([, value]) => value !== undefined),
    ) as Record<string, unknown>;

    if (typeof changes.amount === "number") {
      changes.amount = new Decimal(changes.amount);
    }

    for (const field of ["violation_date", "due_date", "payment_date"]) {
      if (typeof changes[field] === "string") {
        changes[field] = new Date(changes[field] as string);
      }
    }

    const updatedFine: Fine = {
      ...this.fines[index],
      ...(changes as Partial<Fine>),
      updated_at: new Date(),
    };

    this.fines[index] = updatedFine;

    return this.withRelations(updatedFine);
  }

  async deleteFine(fineId: string, businessId: string): Promise<Fine> {
    const index = this.fines.findIndex(
      (fine) => fine.id === fineId && fine.businessId === businessId,
    );

    if (index === -1) {
      throw new Error("Fine not found in this company.");
    }

    return this.fines.splice(index, 1)[0];
  }

  async findFineById(fineId: string): Promise<Fine | null> {
    const found = this.fines.find((fine) => fine.id === fineId);

    return found ? this.withRelations(found) : null;
  }

  async countFinesByDriverId(driverId: string): Promise<number> {
    return this.fines.filter((fine) => fine.driverId === driverId).length;
  }

  private withRelations(fine: Fine): ListedFine {
    const driver = this.drivers.get(fine.driverId);
    const vehicle = this.vehicles.get(fine.vehicleId);
    const code = this.codes.get(fine.trafficViolationCodeId);

    return {
      ...fine,
      branch: {
        corporate_reason:
          this.branches.get(fine.branchId)?.corporate_reason ?? "",
      },
      driver: { name: driver?.name ?? "", cpf: driver?.cpf ?? "" },
      vehicle: {
        license_plate: vehicle?.license_plate ?? "",
        description: vehicle?.description ?? "",
      },
      trafficViolationCode: {
        code: code?.code ?? "",
        sub_code: code?.sub_code ?? 0,
        description: code?.description ?? "",
        gravity: code?.gravity ?? "",
        points: code?.points ?? 0,
      },
    };
  }

  /** Tenant and search: what fineListWhere puts in the base. */
  private matchesBase(fine: Fine, filters: FineListFilters): boolean {
    if (fine.businessId !== filters.businessId) return false;

    const term = filters.search?.trim() ?? "";

    if (!term) return true;

    const row = this.withRelations(fine);
    const needle = term.toLowerCase();

    // Literal substring, case-insensitive: the escaped ILIKE of Postgres.
    const texts = [
      fine.id,
      fine.branchId,
      fine.driverId,
      fine.vehicleId,
      fine.location ?? "",
      fine.observation ?? "",
      row.driver.name,
      row.driver.cpf,
      row.vehicle.license_plate,
      row.vehicle.description,
      row.trafficViolationCode.code,
      row.trafficViolationCode.description,
      row.branch.corporate_reason,
    ];

    if (texts.some((value) => value.toLowerCase().includes(needle)))
      return true;

    const fullCode = FULL_CODE.exec(term);

    if (
      fullCode &&
      row.trafficViolationCode.code === fullCode[1] &&
      row.trafficViolationCode.sub_code === Number(fullCode[2])
    ) {
      return true;
    }

    return (
      MONEY.test(term) &&
      new Decimal(fine.amount.toString()).equals(
        new Decimal(term.replace(",", ".")),
      )
    );
  }

  private matchesFacets(
    fine: Fine,
    filters: FineListFilters,
    todayStart: Date,
  ): boolean {
    const statuses = selectedStatuses(filters);

    if (statuses && !statuses.includes(fineStatus(fine, todayStart))) {
      return false;
    }

    if (
      filters.branchIds?.length &&
      !filters.branchIds.includes(fine.branchId)
    ) {
      return false;
    }

    return (
      !filters.trafficViolationCodeIds?.length ||
      filters.trafficViolationCodeIds.includes(fine.trafficViolationCodeId)
    );
  }

  /** FINE_SORT over rows: the key, then created_at desc, then id desc. */
  private comparator(
    sort: FineSortKey | undefined,
    order: "asc" | "desc" | undefined,
  ): (a: Fine, b: Fine) => number {
    const key = sort ?? FINE_SORT_FALLBACK.sort;
    const direction =
      (order ?? (sort ? "asc" : FINE_SORT_FALLBACK.order)) === "asc" ? 1 : -1;

    const time = (value: Date | string | null | undefined) =>
      value ? new Date(value).getTime() : null;

    const read = (fine: Fine): string | number | null => {
      const row = this.withRelations(fine);

      switch (key) {
        case "created_at":
        case "updated_at":
        case "violation_date":
        case "due_date":
        case "payment_date":
          return time(fine[key]);
        case "amount":
          return Number(fine.amount);
        case "points":
          return fine.points;
        case "violationCode":
          return row.trafficViolationCode.code;
        case "driverName":
          return row.driver.name;
        case "vehicleLicensePlate":
          return row.vehicle.license_plate;
        case "branchName":
          return row.branch.corporate_reason;
      }
    };

    const compare = (left: string | number, right: string | number) =>
      typeof left === "string" && typeof right === "string"
        ? left < right
          ? -1
          : left > right
            ? 1
            : 0
        : Number(left) - Number(right);

    return (a, b) => {
      const left = read(a);
      const right = read(b);

      // Unpaid last in both directions, as `nulls: "last"` does.
      if (left === null || right === null) {
        if (left !== right) return left === null ? 1 : -1;
      } else {
        const primary = direction * compare(left, right);

        if (primary !== 0) return primary;
      }

      return (
        (time(b.created_at) ?? 0) - (time(a.created_at) ?? 0) ||
        compare(b.id, a.id)
      );
    };
  }
}

export { InMemoryFineRepository };
