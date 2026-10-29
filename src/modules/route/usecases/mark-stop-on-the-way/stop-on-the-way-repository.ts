import type { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import type {
  ApplyOnTheWayInput,
  IStopOnTheWayRepository,
  LockedOnTheWayState,
  OnTheWayTarget,
  RecordedOnTheWay,
} from "./IStop-on-the-way-repository";

/**
 * Raised when the stamp matched no row although the route lock was held.
 * Every stop writer takes that lock first, so this is a broken invariant,
 * not a race: it rolls the mark back instead of recording an event for a stop
 * that did not change.
 */
class StopOnTheWayWriteMissedError extends Error {
  constructor() {
    super("A parada mudou durante a marcação de a caminho.");
    this.name = "StopOnTheWayWriteMissedError";
  }
}

class StopOnTheWayRepository implements IStopOnTheWayRepository {
  constructor(private prisma = database) {}

  async findTarget(
    stopId: string,
    routeId: string,
    businessId: string,
  ): Promise<OnTheWayTarget | null> {
    const found = await this.prisma.routeStop.findFirst({
      // The tenant rides in the `where`: another company's stop is absent.
      where: { id: stopId, routeId, route: { businessId } },
      select: {
        id: true,
        routeId: true,
        deliveryId: true,
        status: true,
        on_the_way_at: true,
        route: {
          select: {
            id: true,
            code: true,
            businessId: true,
            driverId: true,
            status: true,
            started_at: true,
          },
        },
        // What the customer notice needs, read with the stop so the
        // message describes the delivery this stop is about.
        delivery: {
          select: {
            id: true,
            businessId: true,
            recipient_name: true,
            recipient_email: true,
            recipient_telephone: true,
            invoice_number: true,
            code: true,
            city: true,
            uf: true,
            scheduled_date: true,
            delivered_at: true,
            received_by: true,
          },
        },
      },
    });

    if (!found) return null;

    const { route, delivery, ...stop } = found;

    return { stop, route, delivery };
  }

  async findBySubmission(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<RecordedOnTheWay | null> {
    const found = await this.prisma.deliveryEvent.findFirst({
      where: { client_submission_id: clientSubmissionId, businessId },
      select: {
        type: true,
        deliveryId: true,
        routeId: true,
        occurred_at: true,
        created_at: true,
      },
    });

    if (!found) return null;

    return {
      type: found.type,
      deliveryId: found.deliveryId,
      routeId: found.routeId,
      at: found.occurred_at ?? found.created_at,
    };
  }

  async lockForMark(
    stopId: string,
    routeId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LockedOnTheWayState | null> {
    // The route row first, FOR UPDATE, like every other stop writer
    // (settleWithin, the cancellation, the plan edits). The event insert
    // below takes a key-share lock on this row through its foreign key; taken
    // stop-first, that crossed a cancellation holding the route and waiting
    // for the stop.
    const [route] = await tx.$queryRaw<
      Array<{ status: string; driverId: string }>
    >`
      SELECT r."status", r."driverId"
      FROM "route" r
      WHERE r."id" = ${routeId} AND r."businessId" = ${businessId}
      FOR UPDATE
    `;

    if (!route) return null;

    const stop = await tx.routeStop.findFirst({
      where: { id: stopId, routeId },
      select: { status: true, deliveryId: true, on_the_way_at: true },
    });

    if (!stop) return null;

    return {
      routeStatus: route.status,
      driverId: route.driverId,
      stopStatus: stop.status,
      deliveryId: stop.deliveryId,
      on_the_way_at: stop.on_the_way_at,
    };
  }

  async applyMark(
    input: ApplyOnTheWayInput,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    // The precondition rides in the write too, not only in the locked read:
    // the tenant and both statuses, as settleWithin does.
    const stamped = await tx.routeStop.updateMany({
      where: {
        id: input.stopId,
        routeId: input.routeId,
        status: "PENDING",
        route: { businessId: input.businessId, status: "IN_PROGRESS" },
      },
      data: { on_the_way_at: input.stopOnTheWayAt },
    });

    if (stamped.count === 0) throw new StopOnTheWayWriteMissedError();

    await tx.deliveryEvent.create({
      data: {
        type: "ON_THE_WAY",
        deliveryId: input.deliveryId,
        businessId: input.businessId,

        // The route it happened on, so the tower's feed can say "Rota 12".
        routeId: input.routeId,

        reportedById: input.reportedById,
        actor: "DRIVER_APP",

        latitude: input.latitude,
        longitude: input.longitude,

        client_submission_id: input.client_submission_id,

        // Always set: a replay answers with exactly this instant.
        occurred_at: input.at,
      },
    });
  }
}

export { StopOnTheWayRepository, StopOnTheWayWriteMissedError };
