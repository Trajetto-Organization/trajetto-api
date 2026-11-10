import type { VehicleStatus } from "./vehicle-rules";

/**
 * What a person may do to a vehicle's status, given the routes that use it
 * (FLEET-ASSIGN-5, decision 8.3).
 *
 * The route owns "Em rota": it writes IN_ROUTE when the driver departs and
 * clears it when the route ends. So while a route is running, the form may
 * BLOCK the truck (theft, crash, breakdown — exactly when someone needs to)
 * and take that block back, which returns it to "Em rota" (the route's
 * status), never to ACTIVE; setting it ACTIVE or INACTIVE otherwise made the
 * vehicle claim to be in the yard, and INACTIVE freed a billed slot with the
 * truck on the road.
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
  /**
   * The unblocking of a truck still on the road: the status is the route's.
   * The write derives it again under the running route's lock — IN_ROUTE
   * while it runs, ACTIVE if it ended in between — so this is the
   * expectation, not the value to store blindly.
   */
  | { kind: "allowed"; status: "IN_ROUTE"; fromRunningRoute: true }
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

  // Unblocking a truck that is still out (a breakdown fixed on the road, the
  // wrong plate blocked): it went on refusing until the route ended, and a
  // blocked truck cannot be refuelled. The route owns the status, so it goes
  // back to IN_ROUTE, never to ACTIVE, which would claim it is in the yard.
  if (
    openRoutes.inProgress > 0 &&
    current === "BLOCKED" &&
    requested === "ACTIVE"
  ) {
    return { kind: "allowed", status: "IN_ROUTE", fromRunningRoute: true };
  }

  // Judged by the route, not by the stored status: an IN_ROUTE left behind
  // with no running route is stale and may be corrected by hand. The
  // sentence follows what the truck already is: "só é possível bloqueá-lo"
  // was said to one that was blocked.
  if (openRoutes.inProgress > 0 && requested !== "BLOCKED") {
    return {
      kind: "refused",
      code: "VEHICLE_IN_ACTIVE_ROUTE",
      message:
        current === "BLOCKED"
          ? "Este veículo está bloqueado durante uma rota em andamento. " +
            "Enquanto ela não termina, ele pode continuar bloqueado ou ser " +
            "desbloqueado (volta para “Em rota”). Para inativá-lo, conclua ou " +
            "cancele a rota."
          : "Este veículo está em uma rota em andamento: enquanto ela não " +
            "termina, o status é definido pela rota. Só é possível bloqueá-lo " +
            "(roubo, acidente, pane).",
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

/**
 * What the answer to an allowed change says beyond "atualizado", for the
 * routes the vehicle is on: blocking it no longer passes in silence while a
 * route is ahead of it (the release and the departure would refuse it), and
 * an unblocking on the road says why the status reads "Em rota". `written` is
 * the status the write stored, so a route that ended in between does not get
 * the "Em rota" sentence. Null: nothing to add.
 */
function statusChangeNotice({
  requested,
  written,
  openRoutes,
}: {
  requested: VehicleStatus;
  written: VehicleStatus;
  openRoutes: OpenRouteCounts;
}): string | null {
  if (requested === "ACTIVE" && written === "IN_ROUTE") {
    return (
      "Veículo desbloqueado. Como ele está numa rota em andamento, o status " +
      "voltou para “Em rota”."
    );
  }

  if (requested !== "BLOCKED") return null;

  const ahead = { ...openRoutes, inProgress: 0 };
  const aheadTotal = openRouteTotal(ahead);

  const parts: string[] = [];

  if (openRoutes.inProgress > 0) {
    parts.push(
      "Veículo bloqueado durante a rota em andamento. Se ele não puder " +
        "seguir, encerre a rota com pendências e monte outra com outro veículo.",
    );
  }

  if (aheadTotal > 0) {
    parts.push(
      `${parts.length > 0 ? "Ele também está" : "Veículo bloqueado. Ele está"} ` +
        `em ${describeOpenRoutes(ahead)}: troque o veículo ` +
        `${aheadTotal === 1 ? "dessa rota" : "dessas rotas"} antes da saída.`,
    );
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

export {
  decideVehicleStatusChange,
  describeOpenRoutes,
  openRouteTotal,
  statusChangeNotice,
};
export type { OpenRouteCounts, StatusChangeRefusal, StatusChangeVerdict };
