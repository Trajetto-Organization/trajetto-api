import { NotificationCategory } from "@prisma/client";

import {
  NotificationPolicyEntry,
  RenderedActivity,
  RenderedPush,
  RenderContext,
  RenderedInApp,
  RouteCancelledPayload,
  RouteLeftOpenPayload,
  RoutePlanChangedPayload,
  RouteRecordBranchMissingPayload,
  RouteReleasedPayload,
} from "../notification-types";
import { PUSH_TTL_SECONDS } from "../push-validity";

import type { User } from "@/modules/user/dtos/user-dto";
import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";

/**
 * The two things a driver has to be told about their route, and nothing else.
 *
 * Push-only, for the same reason the chat is: the driver's route screen is the
 * in-app surface, and a notification row per release would duplicate the thing
 * it points at. The tray has to ring with the app closed, because that is the
 * whole point — the driver is not looking at the phone, they are working.
 *
 * Mandatory, also for the same reason: preferences control noise, not the
 * company telling someone their day changed. A driver who muted task
 * notifications still has to hear that the route they are driving was called
 * off.
 *
 * A departure and a completion are deliberately NOT here. Both are facts the
 * dispatcher's board already shows the moment they happen, and both are
 * recorded in the activity trail; turning them into notifications would mean
 * sixty bells a day at a company with thirty drivers, for events nobody has to
 * act on. That is how a notification system stops being read.
 */
async function recipientDriver(
  routeDriverUserId: string | null,
  users: IUserRepository,
): Promise<User[]> {
  if (!routeDriverUserId) return [];

  const user = await users.findUserById(routeDriverUserId);

  return user ? [user] : [];
}

function renderRouteReleasedPush(payload: RouteReleasedPayload): RenderedPush {
  const label = payload.routeName
    ? `${payload.routeName} (rota ${payload.code})`
    : `Rota ${payload.code}`;

  const stops =
    payload.stopCount === 1 ? "1 parada" : `${payload.stopCount} paradas`;

  return {
    title: "🚚 Sua rota foi liberada",
    body: `${label} — ${stops} para ${payload.scheduledLabel}.`,

    // Straight to the route, not the feed: the driver taps this to start work.
    data: { url: "/route" },
  };
}

function renderRouteCancelledPush(
  payload: RouteCancelledPayload,
): RenderedPush {
  const label = payload.routeName
    ? `${payload.routeName} (rota ${payload.code})`
    : `Rota ${payload.code}`;

  return {
    // The two cases read differently on a lock screen, and the driver who is
    // mid-street needs the stronger one.
    title: payload.hadDeparted
      ? "⛔ Sua rota foi cancelada"
      : "Rota cancelada antes da saída",
    body: `${label}: ${payload.reason}`,
    data: { url: "/route" },
  };
}

/**
 * The stops of a released route changed (decision 14.7, design §7.2). The
 * socket refreshes an open app; this reaches the phone in the driver's pocket
 * before they drive to an address that left the plan.
 */
function renderRoutePlanChangedPush(
  payload: RoutePlanChangedPayload,
): RenderedPush {
  return {
    title: "Sua rota foi alterada",
    body: `O despachante alterou as paradas da rota ${payload.code}. Confira a lista antes de seguir.`,
    // "/route" opens the day's list in the app, like a release.
    data: {
      url: "/route",
      routeId: payload.routeId,
      planVersion: payload.planVersion,
    },
  };
}

const routeReleasedPolicy: NotificationPolicyEntry<RouteReleasedPayload> = {
  category: NotificationCategory.TASKS,
  mandatory: true,

  async resolveRecipients(payload, deps) {
    return recipientDriver(payload.driverUserId, deps.userRepository);
  },

  renderPush: renderRouteReleasedPush,
  pushTtlSeconds: PUSH_TTL_SECONDS.route,
};

const routeCancelledPolicy: NotificationPolicyEntry<RouteCancelledPayload> = {
  category: NotificationCategory.TASKS,
  mandatory: true,

  async resolveRecipients(payload, deps) {
    return recipientDriver(payload.driverUserId, deps.userRepository);
  },

  renderPush: renderRouteCancelledPush,
  pushTtlSeconds: PUSH_TTL_SECONDS.route,
};

const routePlanChangedPolicy: NotificationPolicyEntry<RoutePlanChangedPayload> =
  {
    category: NotificationCategory.TASKS,
    mandatory: true,

    async resolveRecipients(payload, deps) {
      return recipientDriver(payload.driverUserId, deps.userRepository);
    },

    renderPush: renderRoutePlanChangedPush,
    pushTtlSeconds: PUSH_TTL_SECONDS.route,
  };

/** The route page of the panel, where "Encerrar com pendências" lives. */
const ROUTE_PAGE_PATH = "/dashboard/routes";

/**
 * A route left open (K11, D26), to the company's admins: the badge on the
 * tower says it to whoever looks; this says it once to who can close it.
 */
function renderRouteLeftOpenInApp(
  payload: RouteLeftOpenPayload,
  ctx: RenderContext,
): RenderedInApp {
  const label = payload.routeName
    ? `Rota ${payload.code} (${payload.routeName})`
    : `Rota ${payload.code}`;
  const howLong =
    payload.openDays === 0
      ? "há mais de 16 horas"
      : `há ${payload.openDays} ${payload.openDays === 1 ? "dia" : "dias"}`;
  const driver = payload.driverName ? ` com ${payload.driverName}` : "";

  return {
    type: "delivery",
    title: "Rota esquecida em andamento",
    message:
      `${label} está em andamento ${howLong}${driver} (desde ${payload.sinceLabel}). ` +
      "Enquanto ela não for concluída ou cancelada, o motorista e o veículo não saem em outra rota. " +
      "Conclua, cancele ou use Encerrar com pendências.",
    link: `${ctx.baseUrl}${ROUTE_PAGE_PATH}/${payload.routeId}`,
    entityId: payload.routeId,
  };
}

const routeLeftOpenPolicy: NotificationPolicyEntry<RouteLeftOpenPayload> = {
  category: NotificationCategory.TASKS,
  // Somebody has to act on it — the driver cannot leave on the next route —
  // and it rings once per route, never again.
  mandatory: true,

  async resolveRecipients(payload, deps) {
    return deps.userRepository.findBusinessAdminsByBusinessId(
      payload.businessId,
    );
  },

  renderInApp: renderRouteLeftOpenInApp,
};

/**
 * What was refused, by whom, on which route and truck: the first sentence of
 * the notice and the whole of the trail entry.
 */
function recordBranchMissingSentence(
  payload: RouteRecordBranchMissingPayload,
): string {
  const what =
    payload.record === "FUEL"
      ? "Abastecimento"
      : payload.phase === "ROUTE_END"
        ? "Checklist de chegada"
        : "Checklist de saída";
  const driver = payload.driverName ? ` ${payload.driverName}` : "";

  return (
    `${what} do motorista${driver} recusado: a rota ${payload.code} ` +
    `não tem filial ativa (veículo ${payload.vehiclePlate}).`
  );
}

/**
 * A driver's route record refused for want of an active branch (wave 3.7;
 * the product principle: never hold the driver over an admin-side data gap,
 * show it to the dispatcher). The app lets the route go on; this says what
 * to fix and that the driver resends it. The link opens the route, which
 * names the vehicle and the driver.
 */
function renderRouteRecordBranchMissingInApp(
  payload: RouteRecordBranchMissingPayload,
  ctx: RenderContext,
): RenderedInApp {
  const checklist = payload.record === "CHECKLIST";
  // Only the departure checklist holds "Iniciar rota", and the app no
  // longer holds it for this refusal.
  const goesOn =
    checklist && payload.phase === "ROUTE_START"
      ? " A rota segue sem o checklist."
      : "";

  return {
    type: "delivery",
    title: checklist
      ? "Checklist do motorista recusado"
      : "Abastecimento do motorista recusado",
    message:
      `${recordBranchMissingSentence(payload)} ` +
      "Defina uma filial ativa no veículo ou no motorista; depois, o motorista reenvia em Tentar de novo." +
      goesOn,
    link: `${ctx.baseUrl}${ROUTE_PAGE_PATH}/${payload.routeId}`,
    entityId: payload.routeId,
  };
}

/**
 * The route's trail keeps it as history: "Pendente" is what the refusal left
 * open at that moment, and the row stays so. The trail is append-only (no
 * writer updates an Activity row, and the catalog has no "resolved" status
 * to close it with); the driver's later resend shows up as its own entry,
 * the checklist's or the refuelling's "Criado".
 */
function renderRouteRecordBranchMissingActivity(
  payload: RouteRecordBranchMissingPayload,
): RenderedActivity {
  return {
    type: "Rota",
    action: "update",
    entityId: payload.routeId,
    description: recordBranchMissingSentence(payload),
    status: "Pendente",
  };
}

const routeRecordBranchMissingPolicy: NotificationPolicyEntry<RouteRecordBranchMissingPayload> =
  {
    category: NotificationCategory.TASKS,
    // Somebody has to fix a record before the driver can resend it; once per
    // route and moment (the event key), never again.
    mandatory: true,

    // The people who run the deliveries (DLVP-NOTIF-1): the dispatcher
    // watching the tower, and the administrators.
    async resolveRecipients(payload, deps) {
      return deps.userRepository.findDeliveryOperators(payload.businessId);
    },

    renderInApp: renderRouteRecordBranchMissingInApp,
    renderActivity: renderRouteRecordBranchMissingActivity,
  };

export {
  renderRouteLeftOpenInApp,
  renderRouteRecordBranchMissingActivity,
  renderRouteRecordBranchMissingInApp,
  routeLeftOpenPolicy,
  routeRecordBranchMissingPolicy,
  renderRouteCancelledPush,
  renderRoutePlanChangedPush,
  renderRouteReleasedPush,
  routeCancelledPolicy,
  routePlanChangedPolicy,
  routeReleasedPolicy,
};
