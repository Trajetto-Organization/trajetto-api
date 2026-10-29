import { container } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { OutboxService } from "@/shared/notifications/outbox-service";
import { logger } from "@/shared/logging/logger";

import { sendRouteEventToBusiness, sendRouteEventToDriver } from "@/websocket";

import {
  PLANNING_EVENT_TYPES,
  ROUTE_MAX_STOPS,
  ROUTE_STOPS_BATCH_MAX,
  alreadyOnRouteMessage,
  assertPlanVersion,
  planWriteFailure,
} from "./route-plan-rules";

import type { RouteStatus } from "@/shared/route/route-rules";
import type { PlanBump } from "@/modules/route/dtos/route-dto";

/**
 * Tells the screens that the plan of a route changed. Always AFTER the
 * commit: an event about a write that rolled back is a lie the client cannot
 * undo.
 *
 * The operations room always; the driver only while the route is RELEASED —
 * a PLANNED route is a draft that is not theirs yet, and an IN_PROGRESS one
 * is not editable.
 */
async function announcePlanChange(
  users: IUserRepository,
  change: {
    businessId: string;
    routeId: string;
    routeCode: number;
    planVersion: number;
    status: RouteStatus;
    driverId: string;
  },
): Promise<void> {
  const event = {
    type: "route.stops_changed" as const,
    routeId: change.routeId,
    routeCode: change.routeCode,
    planVersion: change.planVersion,
  };

  sendRouteEventToBusiness(change.businessId, event);

  if (change.status === "RELEASED") {
    const driverUser = await users.findUserByDriverId(change.driverId);

    sendRouteEventToDriver(driverUser?.id ?? null, event);

    await publishPlanChanged(change, driverUser?.id ?? null);
  }
}

const log = logger.child({ component: "route" });

/**
 * The push of a released route's new plan (design §7.2), for the phone in
 * the driver's pocket that no socket reaches.
 *
 * After the commit, not in it: the plan writes commit inside the route
 * repository, which knows nothing of the outbox. The key is the plan
 * version, so a retry never pushes twice, and the price of a crash between
 * the commit and this line is one missing push — the app still sees the new
 * plan_version on its next sync and says so (design §6).
 */
async function publishPlanChanged(
  change: {
    businessId: string;
    routeId: string;
    routeCode: number;
    planVersion: number;
  },
  driverUserId: string | null,
): Promise<void> {
  if (!driverUserId || !container.isRegistered("OutboxService")) return;

  try {
    await container.resolve<OutboxService>("OutboxService").publishAfterCommit({
      topic: "route.plan_changed",
      aggregateType: "route",
      aggregateId: change.routeId,
      businessId: change.businessId,
      eventKey: `route:${change.routeId}:plan:${change.planVersion}`,
      payload: {
        routeId: change.routeId,
        businessId: change.businessId,
        driverUserId,
        code: change.routeCode,
        planVersion: change.planVersion,
      },
    });
  } catch (error) {
    // A replay of the same version hits the unique key: already queued.
    if ((error as { code?: string } | null)?.code === "P2002") return;

    log.warn(
      { err: error, routeId: change.routeId, planVersion: change.planVersion },
      "route plan change push could not be queued",
    );
  }
}

/**
 * The plans a delivery outcome took a stop off (settleStopForDelivery's
 * onPlanDropped), announced after the caller's commit.
 */
async function announceDroppedPlans(
  users: IUserRepository,
  businessId: string,
  bumps: PlanBump[],
): Promise<void> {
  for (const bump of bumps) {
    await announcePlanChange(users, {
      businessId,
      routeId: bump.routeId,
      routeCode: bump.code,
      planVersion: bump.planVersion,
      status: bump.status,
      driverId: bump.driverId,
    });
  }
}

export {
  PLANNING_EVENT_TYPES,
  ROUTE_MAX_STOPS,
  ROUTE_STOPS_BATCH_MAX,
  alreadyOnRouteMessage,
  announceDroppedPlans,
  announcePlanChange,
  assertPlanVersion,
  planWriteFailure,
};
