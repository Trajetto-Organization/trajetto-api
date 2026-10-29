import type { VehicleStatus } from "./vehicle-rules";

/**
 * What a person may do to a vehicle's status, given the routes that use it
 * (FLEET-ASSIGN-5, decision 8.3).
 *
 * The route owns "Em rota": it writes IN_ROUTE when the driver departs and
 * clears it when the route ends. So while a route is running, the form may
 * only BLOCK the truck (theft, crash, breakdown — exactly when someone needs
 * to); setting it ACTIVE or INACTIVE there made the vehicle claim to be in the
 * yard, and INACTIVE freed a billed slot with the truck on the road.
 *
 * Inactivating takes the vehicle out of every picker and out of the contract,
 * so it is also refused while a route is planned or released for it — the
 * failure used to surface only in the yard, when "Iniciar rota" broke. The
 * refusal carries the counts, like the shipper's (padrão do embarcador).
 */
interface OpenRouteCounts {
  planned: number;
  released: number;
  inProgress: number;
}

type StatusChangeVerdict =
  | { kind: "unchanged" }
  | { kind: "allowed"; status: Exclude<VehicleStatus, "IN_ROUTE"> }
  | { kind: "refused"; code: StatusChangeRefusal; message: string };

type StatusChangeRefusal =
  | "VEHICLE_STATUS_DERIVED"
  | "VEHICLE_IN_ACTIVE_ROUTE"
  | "VEHICLE_HAS_OPEN_ROUTES";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "2 rotas planejadas e 1 liberada", in the order a dispatcher acts on them. */
function describeOpenRoutes(counts: OpenRouteCounts): string {
  const parts = [
    counts.inProgress > 0 &&
      plural(counts.inProgress, "rota em andamento", "rotas em andamento"),
    counts.released > 0 &&
      plural(counts.released, "rota liberada", "rotas liberadas"),
    counts.planned > 0 &&
      plural(counts.planned, "rota planejada", "rotas planejadas"),
  ].filter((part): part is string => Boolean(part));

  if (parts.length <= 1) return parts[0] ?? "";

  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

function openRouteTotal(counts: OpenRouteCounts): number {
  return counts.planned + counts.released + counts.inProgress;
}

function decideVehicleStatusChange(input: {
  current: VehicleStatus;
  requested: VehicleStatus | undefined;
  openRoutes: OpenRouteCounts;
}): StatusChangeVerdict {
  const { current, requested, openRoutes } = input;

  if (requested === undefined || requested === current) {
    return { kind: "unchanged" };
  }

  if (requested === "IN_ROUTE") {
    return {
      kind: "refused",
      code: "VEHICLE_STATUS_DERIVED",
      message:
        "O status “Em rota” é definido automaticamente quando o motorista " +
        "inicia a rota, e não pode ser atribuído manualmente.",
    };
  }

  // Judged by the route, not by the stored status: an IN_ROUTE left behind
  // with no running route is stale and may be corrected by hand.
  if (openRoutes.inProgress > 0 && requested !== "BLOCKED") {
    return {
      kind: "refused",
      code: "VEHICLE_IN_ACTIVE_ROUTE",
      message:
        "Este veículo está em uma rota em andamento: enquanto ela não termina, " +
        "o status é definido pela rota. Só é possível bloqueá-lo (roubo, " +
        "acidente, pane).",
    };
  }

  if (requested === "INACTIVE" && openRouteTotal(openRoutes) > 0) {
    return {
      kind: "refused",
      code: "VEHICLE_HAS_OPEN_ROUTES",
      message:
        `Não é possível inativar este veículo: ele está em ${describeOpenRoutes(openRoutes)}. ` +
        "Troque o veículo dessas rotas ou cancele-as antes de inativá-lo.",
    };
  }

  return { kind: "allowed", status: requested };
}

export { decideVehicleStatusChange, describeOpenRoutes, openRouteTotal };
export type { OpenRouteCounts, StatusChangeRefusal, StatusChangeVerdict };
