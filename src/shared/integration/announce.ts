import type { Prisma } from "@prisma/client";

import type { Route } from "@/modules/route/dtos/route-dto";
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
function deliveryEventPayload(delivery: {
  id: string;
  code?: string | null;
  invoice_key?: string | null;
  invoice_number?: string | null;
  status?: string;
  recipient_name?: string;
  city?: string;
  uf?: string;
}): Record<string, unknown> {
  return {
    delivery_id: delivery.id,
    code: delivery.code ?? null,
    invoice_key: delivery.invoice_key ?? null,
    invoice_number: delivery.invoice_number ?? null,

    status: delivery.status ?? null,

    recipient_name: delivery.recipient_name ?? null,
    city: delivery.city ?? null,
    uf: delivery.uf ?? null,
  };
}

function routeEventPayload(route: {
  id: string;
  code: number;
  name?: string | null;
  status?: string;
  driverId?: string | null;
  vehicleId?: string | null;
}): Record<string, unknown> {
  return {
    route_id: route.id,
    code: route.code,
    name: route.name ?? null,
    status: route.status ?? null,

    driver_id: route.driverId ?? null,
    vehicle_id: route.vehicleId ?? null,
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
    routeEventPayload(settled.closedRoute),
    tx,
  );
}

export { announceRouteClosed, deliveryEventPayload, routeEventPayload };
