import {
  Driver,
  CreateDriverProps,
  DriverExportFilters,
  ListDriversProps,
  ListDriversResult,
  UpdateDriver,
  SearchDriverWithCursorProps,
  CursorPaginatedDriver,
} from "../dtos/driver-dto";

import type { OpenRouteCounts } from "../driver-rules";

interface IDriverRepository {
  /**
   * Inserts the driver. A CPF or CNH already used in the SAME company is the
   * database's unique (businessId, cpf|cnh): it surfaces as the Prisma P2002
   * the use case turns into a 409 — the twin raises the same error.
   */
  createDriver: (driverData: CreateDriverProps) => Promise<Driver>;

  /** One page of one company's drivers, plus the counts behind its cards and filters. */
  listDrivers: (props: ListDriversProps) => Promise<ListDriversResult>;

  /**
   * Applies the update. Deactivating a driver who is ACTIVE is refused with
   * `DriverHasOpenRoutesError` while they have a PLANNED, RELEASED or
   * IN_PROGRESS route (decision 8.3): the check and the write run under the
   * driver row's lock, so a check that passed is still true when the status
   * changes.
   */
  updateDriver: ({ driverData, driverId }: UpdateDriver) => Promise<Driver>;

  /**
   * Deletes the driver. The history the use case checked is counted again
   * under the driver row's lock, and anything that appeared in between is
   * refused with the same 409 (driverHistoryRefusal) instead of reaching a
   * RESTRICT key or being set to NULL. A missing row is Prisma's P2025.
   */
  deleteDriver: (driverId: string) => Promise<Driver>;
  findDriverById: (driverId: string) => Promise<Driver | null>;

  /** The driver with this CPF in this company (decision 8.1: unique per company). */
  findDriverByCpf: (cpf: string, businessId: string) => Promise<Driver | null>;

  /** The driver with this CNH in this company (decision 8.1: unique per company). */
  findDriverByCnh: (cnh: string, businessId: string) => Promise<Driver | null>;

  findDriverWithUser: (driverId: string) => Promise<
    | (Driver & {
        user?: { id: string; email: string; name: string } | null;
      })
    | null
  >;

  /** Every driver the list's filter keeps, in the list's order, batch by batch. */
  streamDriversForExport: (filters: DriverExportFilters) => AsyncGenerator<any>;

  searchDriverWithCursor: (
    props: SearchDriverWithCursorProps,
  ) => Promise<CursorPaginatedDriver>;

  /**
   * How many drivers the export's filter keeps (the list's search and
   * filters): the export refuses an empty file, like every other export.
   */
  countDriversForExport: (
    filters: Omit<DriverExportFilters, "sort" | "order">,
  ) => Promise<number>;

  /** The driver's routes that still need them, by status. */
  countOpenRoutes: (driverId: string) => Promise<OpenRouteCounts>;

  /** Pauses on the driver's record (DriverPause, RESTRICT on delete). */
  countDriverPauses: (driverId: string) => Promise<number>;
}

export { IDriverRepository };
