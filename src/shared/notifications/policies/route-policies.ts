import { NotificationCategory } from "@prisma/client";

import {
  NotificationPolicyEntry,
  RenderedPush,
  RouteCancelledPayload,
  RoutePlanChangedPayload,
  RouteReleasedPayload,
} from "../notification-types";

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
function renderRoutePlanChangedPush(payload: RoutePlanChangedPayload): RenderedPush {
  return {
    title: "Sua rota foi alterada",
    body: `O despachante alterou as paradas da rota ${payload.code}. Confira a lista antes de seguir.`,
    // "/route" opens the day's list in the app, like a release.
    data: { url: "/route", routeId: payload.routeId, planVersion: payload.planVersion },
  };
}

const routeReleasedPolicy: NotificationPolicyEntry<RouteReleasedPayload> = {
  category: NotificationCategory.TASKS,
  mandatory: true,

  async resolveRecipients(payload, deps) {
    return recipientDriver(payload.driverUserId, deps.userRepository);
  },

  renderPush: renderRouteReleasedPush,
};

const routeCancelledPolicy: NotificationPolicyEntry<RouteCancelledPayload> = {
  category: NotificationCategory.TASKS,
  mandatory: true,

  async resolveRecipients(payload, deps) {
    return recipientDriver(payload.driverUserId, deps.userRepository);
  },

  renderPush: renderRouteCancelledPush,
};

const routePlanChangedPolicy: NotificationPolicyEntry<RoutePlanChangedPayload> = {
  category: NotificationCategory.TASKS,
  mandatory: true,

  async resolveRecipients(payload, deps) {
    return recipientDriver(payload.driverUserId, deps.userRepository);
  },

  renderPush: renderRoutePlanChangedPush,
};

export {
  renderRouteCancelledPush,
  renderRoutePlanChangedPush,
  renderRouteReleasedPush,
  routeCancelledPolicy,
  routePlanChangedPolicy,
  routeReleasedPolicy,
};
