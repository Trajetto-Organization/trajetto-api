import { Prisma } from "@prisma/client";
import { v7 as uuidV7 } from "uuid";

import { DELIVERY_EVENT_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import { StopOnTheWayWriteMissedError } from "./stop-on-the-way-repository";

import type {
  ApplyOnTheWayInput,
  IStopOnTheWayRepository,
  LockedOnTheWayState,
  OnTheWayTarget,
  RecordedOnTheWay,
} from "./IStop-on-the-way-repository";

/** The route row, as the route fake stores it. */
interface RouteMirror {
  id: string;
  code: number;
  businessId: string;
  driverId: string;
  status: string;
  started_at: Date | null;
}

/** The stop row. `on_the_way_at` is absent on rows seeded without it. */
interface StopMirror {
  id: string;
  routeId: string;
  deliveryId: string;
  status: string;
  on_the_way_at?: Date | null;
}

/** The delivery row, as the delivery fake stores it. */
interface DeliveryMirror {
  id?: string;
  businessId: string;
  recipient_name: string;
  recipient_email?: string | null;
  recipient_telephone?: string | null;
  invoice_number?: string | null;
  code?: string | null;
  city: string;
  uf: string;
  scheduled_date?: Date | string | null;
  delivered_at?: Date | string | null;
  received_by?: string | null;
}

/** The delivery_event row, as the delivery fake stores it. */
interface EventMirror {
  id: string;
  type: string;
  deliveryId: string;
  client_submission_id?: string | null;
  occurred_at?: Date | null;
  created_at: Date;
  routeId?: string | null;
  businessId?: string;
  reportedById?: string | null;
  actor?: string;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * The same four operations over the other fakes' OWN arrays: in Postgres the
 * route, its stops, the deliveries and their events are one database, and a
 * fake with a store of its own could prove a mark that no screen would see.
 *
 * Mirrors every condition of the real `where` — the tenant, the route's
 * status and the stop's — and the unique index on `client_submission_id`,
 * raising the same P2002 Prisma raises.
 */
class InMemoryStopOnTheWayRepository implements IStopOnTheWayRepository {
  constructor(
    public routes: RouteMirror[],
    public stops: StopMirror[],
    public deliveries: DeliveryMirror[],
    public events: EventMirror[],
  ) {}

  private routeOf(
    routeId: string,
    businessId: string,
  ): RouteMirror | undefined {
    return this.routes.find(
      (route) => route.id === routeId && route.businessId === businessId,
    );
  }

  private stopOf(stopId: string, routeId: string): StopMirror | undefined {
    return this.stops.find(
      (stop) => stop.id === stopId && stop.routeId === routeId,
    );
  }

  async findTarget(
    stopId: string,
    routeId: string,
    businessId: string,
  ): Promise<OnTheWayTarget | null> {
    const route = this.routeOf(routeId, businessId);
    const stop = this.stopOf(stopId, routeId);

    if (!route || !stop) return null;

    const delivery = this.deliveries.find(
      (entry) => entry.id === stop.deliveryId,
    );

    // A stop always has its delivery (a foreign key); a fake seeded without
    // one reads as the stop being gone rather than as a half row.
    if (!delivery) return null;

    return {
      stop: {
        id: stop.id,
        routeId: stop.routeId,
        deliveryId: stop.deliveryId,
        status: stop.status,
        on_the_way_at: stop.on_the_way_at ?? null,
      },
      route: {
        id: route.id,
        code: route.code,
        businessId: route.businessId,
        driverId: route.driverId,
        status: route.status,
        started_at: route.started_at,
      },
      delivery: {
        ...delivery,
        id: stop.deliveryId,
        recipient_email: delivery.recipient_email ?? null,
        recipient_telephone: delivery.recipient_telephone ?? null,
      },
    };
  }

  async findBySubmission(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<RecordedOnTheWay | null> {
    const found = this.events.find((event) => {
      if (event.client_submission_id !== clientSubmissionId) return false;

      // The event's own company column, as the real `where` reads it; rows
      // the delivery fake wrote without one fall back to their delivery's.
      const tenant =
        event.businessId ??
        this.deliveries.find((entry) => entry.id === event.deliveryId)
          ?.businessId;

      return tenant === businessId;
    });

    if (!found) return null;

    return {
      type: found.type,
      deliveryId: found.deliveryId,
      routeId: found.routeId ?? null,
      at: found.occurred_at ?? found.created_at,
    };
  }

  async lockForMark(
    stopId: string,
    routeId: string,
    businessId: string,
  ): Promise<LockedOnTheWayState | null> {
    // Nothing to lock in one thread; the read is the real one's.
    const route = this.routeOf(routeId, businessId);
    const stop = this.stopOf(stopId, routeId);

    if (!route || !stop) return null;

    return {
      routeStatus: route.status,
      driverId: route.driverId,
      stopStatus: stop.status,
      deliveryId: stop.deliveryId,
      on_the_way_at: stop.on_the_way_at ?? null,
    };
  }

  async applyMark(input: ApplyOnTheWayInput): Promise<void> {
    const route = this.routeOf(input.routeId, input.businessId);
    const stop = this.stopOf(input.stopId, input.routeId);

    if (
      !route ||
      route.status !== "IN_PROGRESS" ||
      !stop ||
      stop.status !== "PENDING"
    ) {
      throw new StopOnTheWayWriteMissedError();
    }

    // The unique index, checked before anything changes: the real
    // transaction rolls the stamp back with the refused insert.
    if (
      this.events.some(
        (event) => event.client_submission_id === input.client_submission_id,
      )
    ) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`client_submission_id`)",
        {
          code: "P2002",
          clientVersion: "in-memory",
          meta: { target: ["client_submission_id"] },
        },
      );
    }

    stop.on_the_way_at = input.stopOnTheWayAt;

    this.events.push({
      ...DELIVERY_EVENT_COLUMN_DEFAULTS,
      id: uuidV7(),
      type: "ON_THE_WAY",
      deliveryId: input.deliveryId,
      businessId: input.businessId,
      routeId: input.routeId,
      client_submission_id: input.client_submission_id,
      occurred_at: input.at,
      created_at: new Date(),
      reportedById: input.reportedById,
      actor: "DRIVER_APP",
      latitude: input.latitude,
      longitude: input.longitude,
    });
  }
}

export { InMemoryStopOnTheWayRepository };
