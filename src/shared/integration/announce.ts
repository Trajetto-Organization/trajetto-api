import type { Prisma } from "@prisma/client";

import type { Route } from "@/modules/route/dtos/route-dto";
import { dateOnlyKey } from "@/shared/time/business-day";
import type { WebhookFanOutService } from "./webhook-fan-out-service";

/**
 * The shapes a webhook payload takes.
 *
 * Here rather than inline at each call site so one topic cannot quietly grow a
 * field another lacks — a subscriber reads `delivery_id` on every document
 * event, and an event that spelled it differently would be an event their code
 * skips.
 *
 * The sending itself is `WebhookFanOutService`, injected: a use case that
 * reached a module singleton would be a use case whose tests cannot say what
 * it sent.
 *
 * The three identifiers, always: our id, the customer's own `code`, and the
 * NF-e access key when there is one. An integration that can only match on one
 * of those breaks the first time a customer's ERP changes how it numbers
 * things — which is the failure the reference product taught.
 */
function deliveryEventPayload(
  delivery: {
    id: string;
    code?: string | null;
    invoice_key?: string | null;
    invoice_number?: string | null;
    status?: string;
    recipient_name?: string;
    city?: string;
    uf?: string;
  },
  /**
   * When the fact happened in the field, for the events that describe one:
   * the proof, the delivery it proved, the occurrence (MOB-08). The
   * envelope's `created_at` is the fan-out — for an action the app queued
   * offline, the upload, hours later. Null on every other event, whose time
   * IS the envelope's; the key is always there, so one shape per topic.
   */
  occurredAt: Date | null = null,
): Record<string, unknown> {
  return {
    delivery_id: delivery.id,
    code: delivery.code ?? null,
    invoice_key: delivery.invoice_key ?? null,
    invoice_number: delivery.invoice_number ?? null,

    status: delivery.status ?? null,

    recipient_name: delivery.recipient_name ?? null,
    city: delivery.city ?? null,
    uf: delivery.uf ?? null,

    occurred_at: occurredAt ? occurredAt.toISOString() : null,
  };
}

/**
 * `delivery.assigned`: the document, and whose hands it is in now.
 *
 * Four paths put a delivery in a driver's hands — building a route, adding
 * stops to one, changing a route's driver or vehicle, and the spreadsheet
 * import building routes — and a subscriber matches on this shape from any of
 * them. One builder, so no path can grow a field another lacks.
 */
function deliveryAssignedPayload(
  delivery: Parameters<typeof deliveryEventPayload>[0],
  route: {
    id: string;
    code: number;
    driverId: string | null;
    vehicleId?: string | null;
  },
): Record<string, unknown> {
  return {
    ...deliveryEventPayload(delivery),
    driver_id: route.driverId,
    vehicle_id: route.vehicleId ?? null,
    route_id: route.id,
    route_code: route.code,
  };
}

function routeEventPayload(
  route: {
    id: string;
    code: number;
    name?: string | null;
    status?: string;
    scheduled_date?: Date | null;
    destination?: string | null;
    planned_departure_at?: Date | null;
    planned_arrival_at?: Date | null;
    driverId?: string | null;
    vehicleId?: string | null;
    started_at?: Date | null;
    completed_at?: Date | null;
  },
  /**
   * When the fact happened in the field, for route.started and
   * route.completed (MOB-08): the departure tap, or the last stop's proof or
   * occurrence. For a route whose work the app sent later, the envelope's
   * created_at is the upload. Null on the other route events.
   */
  occurredAt: Date | null = null,
): Record<string, unknown> {
  return {
    route_id: route.id,
    code: route.code,
    name: route.name ?? null,
    status: route.status ?? null,

    // The route's day is a civil date (decision 1.3): "2026-09-17", never an
    // instant an ERP would shift into its own zone and read as the 16th.
    scheduled_date: route.scheduled_date
      ? dateOnlyKey(route.scheduled_date)
      : null,
    destination: route.destination ?? null,

    // The planned window is a real instant (decision 1.4), sent in UTC.
    planned_departure_at: route.planned_departure_at
      ? route.planned_departure_at.toISOString()
      : null,
    planned_arrival_at: route.planned_arrival_at
      ? route.planned_arrival_at.toISOString()
      : null,

    driver_id: route.driverId ?? null,
    vehicle_id: route.vehicleId ?? null,

    started_at: route.started_at ? route.started_at.toISOString() : null,
    completed_at: route.completed_at ? route.completed_at.toISOString() : null,
    occurred_at: occurredAt ? occurredAt.toISOString() : null,
  };
}

/**
 * A route closes by ITSELF, from whichever stop happened to be last.
 *
 * Four use cases can be that stop — arrival, proof, blocking occurrence, and
 * the panel moving a status by hand — and an integration that heard about the
 * closure from three of those four paths would be an integration with a
 * mystery nobody can reproduce. One shape here, one line at each site.
 *
 * The service arrives as an argument rather than being reached for, because a
 * use case that reaches a module singleton is a use case whose tests cannot
 * say what it sent.
 */
async function announceRouteClosed(
  webhooks: WebhookFanOutService,
  businessId: string,
  settled: { closedRoute: Route | null } | null,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  if (!settled?.closedRoute) return;

  await webhooks.announce(
    "route.completed",
    businessId,
    routeEventPayload(
      settled.closedRoute,
      settled.closedRoute.completed_at ?? null,
    ),
    tx,
  );
}

export {
  announceRouteClosed,
  deliveryAssignedPayload,
  deliveryEventPayload,
  routeEventPayload,
};
