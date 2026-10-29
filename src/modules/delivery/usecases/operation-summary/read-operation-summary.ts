import type { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import type {
  IOperationDayRepository,
  OperationDay,
} from "@/modules/route/repositories/IOperation-day-repository";

import { driverDayLoads } from "@/shared/route/control-tower-rules";

import type { OperationSummary } from "../../dtos/delivery-dto";

interface OperationSummarySources {
  operation: IOperationDayRepository;
  delivery: IDeliveryRepository;
}

/**
 * The monitoring panel's and the dashboard's "Operação de hoje" numbers, on
 * the tower's definition of the day (decision 7.1, DLV-MON-3).
 *
 * Designated, in route, delivered and failed are the day's ACTIVE documents
 * as OperationDayRepository.countDayDeliveries counts them for the funnel and
 * the board by driver: PENDING on the day's routes (or on a route running
 * now), IN_TRANSIT now, DELIVERED by `delivered_at`, FAILED by the failure
 * fact. The summary once had its own SQL for these and counted a PENDING
 * delivery with a driver and no route of the day as designated, so the
 * dashboard said three where the tower said two for the same morning. Only
 * the two numbers the tower does not have are read here: the backlog without
 * a driver (any date) and the driver's reports of the day.
 *
 * One query after the other, never side by side: a panel holds one
 * connection of the pool at a time.
 */
async function readOperationSummary(
  { operation, delivery }: OperationSummarySources,
  businessId: string,
  day: OperationDay,
): Promise<OperationSummary> {
  const counts = await operation.countDayDeliveries(businessId, day);
  const loads = driverDayLoads(counts);

  // Scoped to the company, like the board by driver: a delivery pointing at
  // another tenant's driver never prints that driver's name or CNH.
  const directory = new Map(
    (
      await operation.listDrivers(
        businessId,
        loads.map((load) => load.driverId),
      )
    ).map((driver) => [driver.id, driver]),
  );

  const backlog = await delivery.operationBacklog(businessId, day);

  const totalOf = (status: string): number =>
    counts
      .filter((entry) => entry.status === status)
      .reduce((sum, entry) => sum + entry.total, 0);

  const drivers = loads.map((load) => ({
    ...load,
    driverName: directory.get(load.driverId)?.name ?? "",
    cnh: directory.get(load.driverId)?.cnh ?? "",
  }));

  // Whoever is on the street comes first; ties read alphabetically — the
  // board by driver's order.
  drivers.sort(
    (a, b) =>
      b.inRoute - a.inRoute ||
      a.driverName.localeCompare(b.driverName, "pt-BR") ||
      a.driverId.localeCompare(b.driverId),
  );

  return {
    totals: {
      unassigned: backlog.unassigned,

      // With a driver only: a PENDING document without one is the "Sem rota"
      // backlog above, and counting it here too would show it twice.
      designated: drivers.reduce((sum, row) => sum + row.designated, 0),

      // The funnel's own totals: what is out and what the day resolved,
      // driver or not.
      inRoute: totalOf("IN_TRANSIT"),
      deliveredToday: totalOf("DELIVERED"),
      failedToday: totalOf("FAILED"),

      occurrencesToday: backlog.occurrencesToday,
    },
    drivers,
  };
}

export { readOperationSummary, type OperationSummarySources };
