import type {
  AssignmentPreview,
  AssignmentRouteRef,
} from "../../dtos/route-dto";

import { cnhCovers, isCnhCategory } from "@/shared/route/cnh-coverage";
import { businessDateKey, dateOnlyKey } from "@/shared/time/business-day";

/**
 * What the assignment dialog warns about before a pair is chosen
 * (FLEET-ASSIGN-2). Warnings, never refusals: substituting a driver's truck,
 * or planning a vehicle that is on the street today for tomorrow, is an
 * ordinary morning. What the database refuses (a second departure of the
 * same truck or driver) is refused at the departure, with its own message;
 * saying it here moves the discovery from the yard to the office.
 *
 * Decision 8.5 adds the fleet's own facts, also as warnings: an expired or
 * incompatible CNH, an open service order and a rejected last checklist. The
 * last two exist only for a company with the FLEET module; the repository
 * does not read them otherwise, so they never appear here.
 */
type AssignmentWarningCode =
  | "DRIVER_ON_ROUTE"
  | "DRIVER_BOOKED_ON_DAY"
  | "DRIVER_CNH_EXPIRED"
  | "DRIVER_CNH_INCOMPATIBLE"
  | "DRIVER_CNH_CATEGORY_UNKNOWN"
  | "VEHICLE_OUT_OF_OPERATION"
  | "VEHICLE_IN_ROUTE"
  | "VEHICLE_OTHER_RESPONSIBLE"
  | "VEHICLE_BOOKED_ON_DAY"
  | "VEHICLE_OPEN_SERVICE_ORDER"
  | "VEHICLE_CHECKLIST_REJECTED";

/** A checklist's overall_condition when it failed. */
const REJECTED_CHECKLIST = "rejected";

/** "17/09/2026" of a "YYYY-MM-DD" key. */
function keyToBR(key: string): string {
  const [year, month, day] = key.split("-");

  return `${day}/${month}/${year}`;
}

interface AssignmentWarning {
  code: AssignmentWarningCode;
  message: string;
}

/** "a Rota 12" / "as Rotas 12 e 14" / "as Rotas 12, 14 e 15". */
function routesPhrase(routes: AssignmentRouteRef[]): string {
  const codes = routes.map((route) => String(route.code));

  if (codes.length === 1) return `a Rota ${codes[0]}`;

  return `as Rotas ${codes.slice(0, -1).join(", ")} e ${codes[codes.length - 1]}`;
}

function assignmentWarnings(
  preview: AssignmentPreview,
  {
    driverId,
    excludeRouteId,
    day,
    timeZone,
  }: {
    driverId: string;
    /** The route being edited: its own rows are not a conflict with itself. */
    excludeRouteId?: string | null;
    /** The route's day (date-only): a CNH valid through it is not expired. */
    day: Date;
    /** The company's zone, to date an order opened at an instant. */
    timeZone: string;
  },
): AssignmentWarning[] {
  const warnings: AssignmentWarning[] = [];

  // Neither the route being edited nor a route this assignment empties (and
  // cancels) is a conflict: the dispatcher would be warned about the very
  // route the documents are leaving.
  const leaving = new Set(preview.routesEmptiedBySelection);

  const others = (routes: AssignmentRouteRef[]) =>
    routes.filter((route) => route.id !== excludeRouteId && !leaving.has(route.id));

  const driverName = preview.driver?.name ?? "O motorista";

  const driverRunning =
    preview.driverRunningRoute &&
    preview.driverRunningRoute.id !== excludeRouteId
      ? preview.driverRunningRoute
      : null;

  if (driverRunning) {
    warnings.push({
      code: "DRIVER_ON_ROUTE",
      message:
        `${driverName} está com a Rota ${driverRunning.code} em andamento; ` +
        "uma nova rota só pode sair quando essa terminar.",
    });
  }

  const driverDay = others(preview.driverRoutesOnDay);

  if (driverDay.length > 0) {
    warnings.push({
      code: "DRIVER_BOOKED_ON_DAY",
      message: `${driverName} já tem ${routesPhrase(driverDay)} para este dia.`,
    });
  }

  const driverCnh = preview.driver;

  // Valid THROUGH the expiry day: expired only when it ends before the route.
  if (
    driverCnh?.cnh_expires_at &&
    dateOnlyKey(driverCnh.cnh_expires_at) < dateOnlyKey(day)
  ) {
    warnings.push({
      code: "DRIVER_CNH_EXPIRED",
      message: `A CNH de ${driverName} venceu em ${keyToBR(dateOnlyKey(driverCnh.cnh_expires_at))}.`,
    });
  }

  const vehicle = preview.vehicle;

  if (!vehicle) return warnings;

  const plate = vehicle.license_plate;

  const required = isCnhCategory(vehicle.required_cnh_category)
    ? vehicle.required_cnh_category
    : null;

  if (required) {
    const held = driverCnh?.cnh_category;

    if (!isCnhCategory(held)) {
      warnings.push({
        code: "DRIVER_CNH_CATEGORY_UNKNOWN",
        message: `O veículo ${plate} exige CNH categoria ${required}, e a categoria da CNH de ${driverName} não está cadastrada.`,
      });
    } else if (!cnhCovers(held, required)) {
      warnings.push({
        code: "DRIVER_CNH_INCOMPATIBLE",
        message: `O veículo ${plate} exige CNH categoria ${required}, e a CNH de ${driverName} é categoria ${held}.`,
      });
    }
  }

  if (vehicle.status !== "ACTIVE" && vehicle.status !== "IN_ROUTE") {
    warnings.push({
      code: "VEHICLE_OUT_OF_OPERATION",
      message: `O veículo ${plate} está inativo ou bloqueado e não pode receber uma rota.`,
    });
  }

  const vehicleRunning =
    preview.vehicleRunningRoute &&
    preview.vehicleRunningRoute.id !== excludeRouteId
      ? preview.vehicleRunningRoute
      : null;

  if (vehicleRunning) {
    const withWhom = vehicleRunning.driverName
      ? `, com ${vehicleRunning.driverName}`
      : "";

    warnings.push({
      code: "VEHICLE_IN_ROUTE",
      message:
        `O veículo ${plate} está em rota agora (Rota ${vehicleRunning.code}${withWhom}); ` +
        "ele só pode sair de novo quando essa rota terminar.",
    });
  }

  if (vehicle.responsible && vehicle.responsible.id !== driverId) {
    warnings.push({
      code: "VEHICLE_OTHER_RESPONSIBLE",
      message:
        `O responsável pelo veículo ${plate} é ${vehicle.responsible.name}. ` +
        "A atribuição continua permitida.",
    });
  }

  // A route already named for the driver is not named again for the truck.
  const namedForDriver = new Set(driverDay.map((route) => route.id));

  const vehicleDay = others(preview.vehicleRoutesOnDay).filter(
    (route) => !namedForDriver.has(route.id),
  );

  if (vehicleDay.length > 0) {
    warnings.push({
      code: "VEHICLE_BOOKED_ON_DAY",
      // "n" + "a Rota 12" / "as Rotas 12 e 14" reads "na" / "nas".
      message: `O veículo ${plate} já está n${routesPhrase(vehicleDay)} deste dia.`,
    });
  }

  // Null when not read: the company has no FLEET module.
  const { count: openOrders, oldest } = vehicle.openServiceOrders ?? {
    count: 0,
    oldest: null,
  };

  if (openOrders > 0) {
    // The order opened at an instant; its day is the company's.
    const openedOn = oldest ? keyToBR(businessDateKey(oldest, timeZone)) : null;

    warnings.push({
      code: "VEHICLE_OPEN_SERVICE_ORDER",
      message:
        openOrders === 1
          ? `O veículo ${plate} tem 1 ordem de serviço aberta${openedOn ? ` desde ${openedOn}` : ""}.`
          : `O veículo ${plate} tem ${openOrders} ordens de serviço abertas${openedOn ? `, a mais antiga desde ${openedOn}` : ""}.`,
    });
  }

  const checklist = vehicle.lastChecklist;

  if (checklist && checklist.overall_condition === REJECTED_CHECKLIST) {
    warnings.push({
      code: "VEHICLE_CHECKLIST_REJECTED",
      message: `O último checklist do veículo ${plate}, de ${keyToBR(businessDateKey(checklist.checklist_date, timeZone))}, foi reprovado.`,
    });
  }

  return warnings;
}

export { assignmentWarnings, routesPhrase };
export type { AssignmentWarning, AssignmentWarningCode };
