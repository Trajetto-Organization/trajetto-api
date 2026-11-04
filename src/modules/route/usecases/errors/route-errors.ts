import { AppError } from "@/shared/errors/AppError";

/**
 * A delivery route that does not exist, or belongs to another company or
 * another driver (same answer, so an id cannot be probed across tenants).
 *
 * Not ROUTE_NOT_FOUND: that code is the unknown-endpoint 404 (http.ts), which
 * the mobile outbox reads as "this app build is outdated" and replays after
 * every upgrade. A queued departure on a route that was taken away must fail
 * on the merits instead.
 */
class RouteNotFoundError extends AppError {
  constructor() {
    super(
      "Rota não encontrada! Por favor, tente novamente.",
      404,
      "DELIVERY_ROUTE_NOT_FOUND",
    );
    this.name = "RouteNotFoundError";
  }
}

class RouteNotBelongBusinessError extends Error {
  constructor() {
    super("Esta rota não pertence à empresa informada.");
  }
}

/**
 * The route moved between the moment its status was read and validated and the
 * moment the write ran, so nothing was written.
 *
 * Four surfaces drive the same route — the driver's app, the dispatcher's
 * dashboard, the admin panel and the control tower — and they are frequently
 * looking at it at the same time. Same reasoning, and same 409, as
 * DeliveryStatusConflictError.
 */
class RouteStatusConflictError extends Error {
  constructor() {
    super(
      "O status desta rota mudou enquanto você trabalhava nela e nada foi " +
        "gravado. Atualize a tela e tente novamente.",
    );
  }
}

/**
 * Raised by the partial unique index `route_active_vehicle_idx`.
 *
 * Planning two routes for the same vehicle is allowed on purpose — a
 * dispatcher lays out the whole week. What cannot happen is the second
 * departure: the truck is on one road.
 */
class RouteVehicleBusyError extends Error {
  constructor() {
    super(
      "Este veículo já está em outra rota em andamento. Encerre a rota atual " +
        "ou escolha outro veículo.",
    );
  }
}

/**
 * The driver already has another route IN_PROGRESS (FLEET-ASSIGN-3).
 *
 * The person, like the truck, is on one road. Planning and releasing several
 * routes for one driver stays allowed — tomorrow's route is released while
 * today's is still out — what is refused is the second departure. Checked
 * under a per-driver lock in the departure's transaction, so two taps on two
 * released routes cannot both win.
 */
class RouteDriverBusyError extends Error {
  constructor(public readonly runningCode: number | null = null) {
    super(
      (runningCode
        ? `Você já está com a Rota ${runningCode} em andamento. `
        : "Você já está com outra rota em andamento. ") +
        "Conclua essa rota (ou peça ao despachante para cancelá-la) antes de iniciar outra.",
    );
    this.name = "RouteDriverBusyError";
  }
}

/**
 * Raised by the partial unique index `route_stop_active_delivery_idx`.
 *
 * The message names the situation rather than the constraint, because the
 * dispatcher's next move depends on it: the delivery is not "invalid", it is
 * somewhere else.
 */
class DeliveryAlreadyOnRouteError extends Error {
  constructor(count: number) {
    super(
      count === 1
        ? "Uma das entregas já está em outra rota em andamento. Atualize a " +
            "lista e tente novamente."
        : `${count} das entregas já estão em outra rota em andamento. ` +
            "Atualize a lista e tente novamente.",
    );
  }
}

/**
 * A delivery stopped being PENDING between the use case's check and the write
 * that puts it on a route — cancelled on the panel, or sent out by hand, in
 * the same instant.
 *
 * Raised by the write itself: the mirror onto the deliveries only matches
 * PENDING rows, and a count short of the selection means one of them moved.
 * The whole route write rolls back, so no open stop is left pointing at an
 * address nobody will visit (a route that can never close).
 */
class DeliveryNoLongerRoutableError extends Error {
  constructor() {
    super(
      "Uma das entregas mudou de status enquanto a rota era montada. " +
        "Atualize a tela e tente novamente.",
    );
    this.name = "DeliveryNoLongerRoutableError";
  }
}

class RouteDriverInactiveError extends Error {
  constructor() {
    super("Só é possível montar uma rota para um motorista ativo.");
  }
}

class RouteVehicleUnavailableError extends Error {
  constructor() {
    super(
      "O veículo selecionado está inativo ou bloqueado e não pode receber " +
        "uma rota.",
    );
  }
}

/** A stop that no longer exists, or that belongs to a different route. */
class RouteStopNotFoundError extends Error {
  constructor() {
    super("Parada não encontrada nesta rota.");
  }
}

/**
 * The reorder did not describe the route's current stops.
 *
 * Reordering takes the COMPLETE list rather than a move instruction, so a list
 * that does not match means the dispatcher was looking at a stale route — a
 * stop was added or removed by someone else in the meantime.
 */
class RouteReorderMismatchError extends Error {
  constructor() {
    super(
      "A ordem enviada não corresponde às paradas atuais da rota. Atualize a " +
        "tela e refaça a ordenação.",
    );
  }
}

/**
 * Two dispatchers took the same route number at the same instant.
 *
 * Nobody did anything wrong and nothing is broken: the per-company code is
 * allocated by reading the highest one and adding a step, and two readers in
 * the same millisecond read the same number. Retrying picks the next one.
 *
 * It exists as its own error because the retry used to live inside the
 * repository, where it could re-run the INSERT on its own. Once the caller
 * owns the transaction — which is what makes the route and its events
 * atomic — the repository can no longer retry anything, so it has to say
 * what happened and let the caller run the whole unit of work again.
 */
class RouteCodeTakenError extends Error {
  constructor() {
    super("O número da rota já foi usado. Tente novamente.");
    this.name = "RouteCodeTakenError";
  }
}

/**
 * The dispatcher edited a plan that changed since they read it (decision
 * 14.7, D5). Carries the version the route is at now, for the caller.
 */
class RoutePlanStaleError extends Error {
  constructor(public readonly currentPlanVersion: number) {
    super(
      "Outra pessoa alterou esta rota enquanto você editava. Recarregamos a " +
        "rota: confira e refaça a alteração.",
    );
    this.name = "RoutePlanStaleError";
  }
}

/** The route would hold more open stops than ROUTE_MAX_STOPS. */
class RouteStopsLimitError extends Error {
  constructor(max: number) {
    super(`Uma rota tem no máximo ${max} paradas abertas.`);
    this.name = "RouteStopsLimitError";
  }
}

/**
 * The company asks for the route's checklist and the record branch it would
 * be filed under resolves to nothing (contract C1 of 03/11/2026): the
 * vehicle has no branch, the driver has none, and the company has no single
 * active branch to fall back on. Refused at the release (and on a crew
 * change of a released route) because the driver would otherwise find out
 * at the truck, with the checklist refused and the route unable to start.
 * The plate and the name tell the dispatcher which record to complete.
 */
class RouteBranchRequiredError extends AppError {
  constructor(plate: string | null, driverName: string | null) {
    super(
      "O checklist desta empresa exige filial: defina a filial " +
        `${plate ? `do veículo ${plate}` : "do veículo da rota"} ou ` +
        `${driverName ? `do motorista ${driverName}` : "do motorista da rota"}.`,
      409,
      "ROUTE_BRANCH_REQUIRED",
    );
    this.name = "RouteBranchRequiredError";
  }
}

/**
 * No ACTIVE record branch resolves, and the vehicle or the driver names one
 * that is switched off: the driver's checklist skips it, finds nothing after
 * it (no active driver branch, no single active one in the company) and is
 * refused, so the route would never start. Deactivating a branch only checks
 * its drivers' open routes, so a truck can keep pointing at one. Same code
 * as the blank case (ROUTE_BRANCH_REQUIRED): the web and the app show the
 * message as it comes; the sentence names the branch so the dispatcher knows
 * what to fix. With an active branch to fall back on, nothing is refused
 * (wave 3.7).
 */
class RouteBranchInactiveError extends AppError {
  constructor(
    branchName: string,
    holder:
      { kind: "vehicle"; plate: string } | { kind: "driver"; name: string },
  ) {
    const of =
      holder.kind === "vehicle"
        ? `do veículo ${holder.plate}`
        : `do motorista ${holder.name}`;
    const record = holder.kind === "vehicle" ? "do veículo" : "do motorista";

    super(
      `O checklist desta empresa exige filial ativa: a filial ${branchName} ${of} está inativa. ` +
        `Reative a filial ou troque a filial ${record}.`,
      409,
      "ROUTE_BRANCH_REQUIRED",
    );
    this.name = "RouteBranchInactiveError";
  }
}

export {
  RouteBranchInactiveError,
  RouteBranchRequiredError,
  RoutePlanStaleError,
  RouteStopsLimitError,
  RouteCodeTakenError,
  DeliveryAlreadyOnRouteError,
  DeliveryNoLongerRoutableError,
  RouteDriverBusyError,
  RouteDriverInactiveError,
  RouteNotBelongBusinessError,
  RouteNotFoundError,
  RouteReorderMismatchError,
  RouteStatusConflictError,
  RouteStopNotFoundError,
  RouteVehicleBusyError,
  RouteVehicleUnavailableError,
};
