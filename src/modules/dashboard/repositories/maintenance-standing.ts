import type { MaintenanceStatsResult } from "../dtos/dashboard-dto";

import {
  businessDateKey,
  dateOnlyKey,
  shiftDateKey,
  shiftDateKeyByMonths,
} from "@/shared/time/business-day";

/**
 * Where a vehicle's next maintenance stands on the company's today: the rule
 * behind the "Manutenção da frota" card.
 *
 * The SQL in DashboardRepository.getMaintenanceStats computes the same thing
 * in the database; the in-memory twin calls this. tests/E2E/
 * dashboard-maintenance-stats runs both over the same rows.
 *
 * Every comparison is between civil days ("YYYY-MM-DD"), never instants: the
 * old version compared an instant with the server's clock, so a vehicle due
 * today turned "Atrasada" as soon as its hour had passed, and one due
 * tomorrow did at 21:00 in São Paulo (the UTC container's midnight).
 */

/** How far ahead a due day still reads "A vencer" and not "Em dia". */
const DUE_SOON_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

type MaintenanceStanding = "overdue" | "pending" | "recent";

interface MaintenanceVehicle {
  last_maintenance_date: Date | null;
  maintenance_interval_months: number;
  current_mileage: number;
  last_maintenance_mileage: number | null;
  maintenance_interval_km: number;
}

/**
 * The civil day of a last maintenance.
 *
 * The column is a timestamp holding an instant: the web's date picker sends
 * the user's local midnight (03:00 UTC in São Paulo) and a service order its
 * completion, so the day is read in the company's zone. A value at exactly
 * 00:00:00.000 UTC is a "YYYY-MM-DD" parsed by the API (integrations, older
 * rows): no Brazilian midnight falls there (the zones are UTC-2 to UTC-5), so
 * its day is the UTC day, as for a date-only column.
 */
function maintenanceDayKey(value: Date, timeZone: string): string {
  return value.getTime() % DAY_MS === 0
    ? dateOnlyKey(value)
    : businessDateKey(value, timeZone);
}

/** The due day: the last maintenance's day plus the interval, end of month clamped. */
function maintenanceDueKey(
  vehicle: MaintenanceVehicle,
  timeZone: string,
): string | null {
  if (!vehicle.last_maintenance_date) return null;

  return shiftDateKeyByMonths(
    maintenanceDayKey(vehicle.last_maintenance_date, timeZone),
    vehicle.maintenance_interval_months,
  );
}

/**
 * Overdue by mileage or when the due day is before today (due today is not
 * late yet); "A vencer" up to today + 30 days, or when no maintenance was ever
 * recorded; "Em dia" beyond that. A missing last mileage counts from zero, as
 * it always has.
 */
function maintenanceStanding(
  vehicle: MaintenanceVehicle,
  today: string,
  timeZone: string,
): MaintenanceStanding {
  const due = maintenanceDueKey(vehicle, timeZone);

  if (due === null) return "pending";

  const kmDue =
    vehicle.current_mileage >=
    (vehicle.last_maintenance_mileage ?? 0) + vehicle.maintenance_interval_km;

  if (kmDue || due < today) return "overdue";

  return due <= shiftDateKey(today, DUE_SOON_DAYS) ? "pending" : "recent";
}

function tallyMaintenance(
  vehicles: MaintenanceVehicle[],
  today: string,
  timeZone: string,
): MaintenanceStatsResult {
  const stats: MaintenanceStatsResult = { pending: 0, recent: 0, overdue: 0 };

  for (const vehicle of vehicles) {
    stats[maintenanceStanding(vehicle, today, timeZone)] += 1;
  }

  return stats;
}

export {
  DUE_SOON_DAYS,
  maintenanceDayKey,
  maintenanceDueKey,
  maintenanceStanding,
  tallyMaintenance,
};
export type { MaintenanceStanding, MaintenanceVehicle };
