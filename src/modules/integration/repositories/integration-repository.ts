import database from "@/../infra/database";

import { Prisma } from "@prisma/client";

import type {
  CursorPage,
  IIntegrationRepository,
  IntegrationListProps,
} from "./IIntegration-repository";

import {
  toIso,
  toPublicDelivery,
  toPublicRoute,
  type PublicDelivery,
  type PublicRoute,
} from "@/shared/integration/public-shapes";

import type { StoredDelivery } from "../usecases/create-delivery/replay-fingerprint";

/** The columns the public delivery shape reads, and no others. */
const deliverySelect = {
  id: true,
  code: true,
  invoice_key: true,
  invoice_number: true,
  status: true,
  recipient_name: true,
  recipient_document: true,
  street: true,
  address_number: true,
  complement: true,
  neighborhood: true,
  city: true,
  uf: true,
  cep: true,
  scheduled_date: true,
  delivered_at: true,
  received_by: true,
  created_at: true,
  updated_at: true,

  stops: {
    orderBy: { created_at: "desc" as const },
    take: 1,
    select: { route: { select: { id: true, code: true } } },
  },
};

const routeSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  scheduled_date: true,
  destination: true,
  planned_departure_at: true,
  planned_arrival_at: true,
  started_at: true,
  completed_at: true,
  created_at: true,

  driver: { select: { id: true, name: true } },
  vehicle: { select: { id: true, license_plate: true } },

  stops: {
    orderBy: { sequence: "asc" as const },
    select: {
      sequence: true,
      status: true,
      delivery: { select: { id: true, code: true, invoice_key: true } },
    },
  },
};

/**
 * Cursor paging, keyed on the row id.
 *
 * `id` and not `updated_at`: the cursor has to be unique or a page boundary
 * between two rows written in the same millisecond either repeats a document
 * or skips one — and an integration that silently loses a delivery is the
 * worst failure this API can have, because nobody notices for weeks.
 */
function cursorPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): { page: T[]; next_cursor: string | null } {
  const page = rows.slice(0, limit);

  return {
    page,
    next_cursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

/**
 * The public name of a delivery event in the feed, or null when the feed
 * leaves it out.
 *
 * `PROOF` is an internal word; the catalogue says `proof.registered` and that
 * is what a subscriber matched on. "A caminho" (decision 6.4) is named like
 * the arrival: an operational fact, not a webhook topic. An occurrence report
 * (TWR-6) is `occurrence.reported`, the webhook's name, once it took effect:
 * a request still waiting for the tower, denied, or closed without a decision
 * (decision 6.3) changed nothing and sent no webhook, so the feed does not
 * announce it either. The judgement is read now, at poll time; a request
 * approved after a poller walked past it reaches that poller through the
 * `delivery.failed` the approval writes, when the type blocks the delivery.
 */
function publicEventTopic(event: {
  type: string;
  status_to: string | null;
  occurrence?: {
    authorization_status: string | null;
    category?: string | null;
  } | null;
}): string | null {
  switch (event.type) {
    case "PROOF":
      return "proof.registered";
    case "ARRIVAL":
      return "delivery.arrived";
    case "ON_THE_WAY":
      return "delivery.on_the_way";
    case "STATUS_CHANGE":
      return `delivery.${(event.status_to ?? "").toLowerCase()}`;
    case "OCCURRENCE": {
      // Decision 14.3: a delivery request (DELIVERED) is not a problem. Its
      // fact is the PROOF (proof.registered), whatever the tower decided.
      if (event.occurrence?.category === "DELIVERED") return null;

      // A report whose occurrence row is gone (SetNull) is still a report.
      const status = event.occurrence?.authorization_status ?? "NOT_REQUIRED";

      return status === "NOT_REQUIRED" || status === "APPROVED"
        ? "occurrence.reported"
        : null;
    }
    // Decision 14.7: a route plan change is planning, not a public fact of
    // the delivery; the integrator learns the outcome from the delivery's
    // own events.
    case "ROUTE_ADDED":
    case "ROUTE_REMOVED":
      return null;
    default:
      return "delivery.note";
  }
}

/**
 * How far an event id's clock may trail the row's created_at.
 *
 * The id is a uuid v7 minted by the API process; created_at is the database's
 * now() at the start of the transaction. The id is minted later than that, so
 * it normally runs ahead — only an API clock behind the database's could put
 * it behind, and NTP keeps that to milliseconds. Ten minutes is a margin no
 * sane clock needs, and costs a poller ten minutes of extra rows read.
 */
const EVENT_ID_CLOCK_MARGIN_MS = 10 * 60 * 1000;

/**
 * The smallest uuid v7 an event written at or after `since` can carry.
 *
 * `updated_since` filters on created_at, but the page is walked in id order
 * over (businessId, id). Without a lower bound on the id, that walk starts at
 * the tenant's OLDEST event and reads its whole history up to `since` before
 * the first row qualifies — the planner cannot know that ids and created_at
 * rise together. A uuid v7 starts with its millisecond timestamp, so this
 * bound starts the walk at the window instead. It only narrows where the
 * index scan begins: created_at stays the filter, so the answer is the same.
 *
 * Relies on DeliveryEvent.id being `@default(uuid(7))` — pinned by
 * tests/unitaires/integration/integration-repository-events.test.ts.
 */
function eventIdFloor(since: Date): string | null {
  const at = since.getTime() - EVENT_ID_CLOCK_MARGIN_MS;

  if (!Number.isFinite(at)) return null;

  const hex = Math.max(0, at).toString(16).padStart(12, "0");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

class IntegrationRepository implements IIntegrationRepository {
  constructor(private prisma = database) {}

  async listDeliveries({
    businessId,
    limit,
    cursor,
    updated_since,
    status,
  }: IntegrationListProps): Promise<CursorPage<PublicDelivery>> {
    const rows = await this.prisma.delivery.findMany({
      where: {
        businessId,
        ...(status && {
          status: status as Prisma.EnumDeliveryStatusFilter["equals"],
        }),
        ...(updated_since && { updated_at: { gte: new Date(updated_since) } }),
      },

      select: deliverySelect,
      orderBy: { id: "asc" },

      // One more than asked, so "is there another page?" costs nothing extra.
      take: limit + 1,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
    });

    const { page, next_cursor } = cursorPage(rows, limit);

    return { data: page.map(toPublicDelivery), next_cursor };
  }

  async findDelivery(
    businessId: string,
    deliveryId: string,
  ): Promise<PublicDelivery | null> {
    const found = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, businessId },
      select: deliverySelect,
    });

    return found ? toPublicDelivery(found) : null;
  }

  async listRoutes({
    businessId,
    limit,
    cursor,
    updated_since,
    status,
  }: IntegrationListProps): Promise<CursorPage<PublicRoute>> {
    const rows = await this.prisma.route.findMany({
      where: {
        businessId,
        ...(status && {
          status: status as Prisma.EnumRouteStatusFilter["equals"],
        }),
        ...(updated_since && { updated_at: { gte: new Date(updated_since) } }),
      },

      select: routeSelect,
      orderBy: { id: "asc" },

      take: limit + 1,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
    });

    const { page, next_cursor } = cursorPage(rows, limit);

    return { data: page.map(toPublicRoute), next_cursor };
  }

  async findRoute(
    businessId: string,
    routeId: string,
  ): Promise<PublicRoute | null> {
    const found = await this.prisma.route.findFirst({
      where: { id: routeId, businessId },
      select: routeSelect,
    });

    return found ? toPublicRoute(found) : null;
  }

  async listEvents({
    businessId,
    limit,
    cursor,
    updated_since,
  }: IntegrationListProps): Promise<
    CursorPage<{
      id: string;
      topic: string;
      occurred_at: string;
      delivery: { id: string; code: string | null; invoice_key: string | null };
      data: Record<string, unknown>;
    }>
  > {
    // Read from the delivery events themselves rather than from the outbox:
    // the outbox is purged, and an integration that polls a week of history
    // must not find a hole where the cleanup ran.
    //
    // The tenant is the event's own column, not `delivery: { businessId }`.
    // Through the relation Postgres either walked the primary key across
    // every tenant's events, joining each to its delivery, or joined all the
    // tenant's deliveries and sorted their whole history to keep one page.
    // (businessId, id) walks exactly this tenant in cursor order and stops at
    // the page; the delivery is then read by primary key for the rows kept.
    const since = updated_since ? new Date(updated_since) : null;
    const idFloor = since ? eventIdFloor(since) : null;

    const rows = await this.prisma.deliveryEvent.findMany({
      where: {
        businessId,
        ...(since && { created_at: { gte: since } }),
        ...(idFloor && { id: { gte: idFloor } }),
      },

      select: {
        id: true,
        type: true,
        created_at: true,
        occurred_at: true,
        status_from: true,
        status_to: true,
        received_by: true,
        note: true,

        delivery: { select: { id: true, code: true, invoice_key: true } },
        // Whether an occurrence report took effect (see publicEventTopic).
        occurrence: { select: { authorization_status: true, category: true } },
      },

      orderBy: { id: "asc" },

      take: limit + 1,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
    });

    const { page, next_cursor } = cursorPage(rows, limit);

    // Left-out events are dropped AFTER the page is cut: the cursor stays the
    // last row read, so the walk never skips or repeats one, even when a page
    // comes back shorter than the limit.
    const published = page.flatMap((event) => {
      const topic = publicEventTopic(event);

      return topic ? [{ event, topic }] : [];
    });

    return {
      data: published.map(({ event, topic }) => ({
        id: event.id,

        // The public name, not the column (see publicEventTopic).
        topic,

        // What the field promises: when it happened. A proof the driver's app
        // sent hours later carries the moment it was signed (MOB-08); the
        // `updated_since` filter above stays on created_at, the receipt, so a
        // late-arriving event is never skipped by a poller already past it.
        occurred_at: toIso(event.occurred_at ?? event.created_at)!,

        delivery: event.delivery,

        data: {
          status_from: event.status_from,
          status_to: event.status_to,
          received_by: event.received_by,
          note: event.note,
        },
      })),

      next_cursor,
    };
  }

  async findSubmission(
    businessId: string,
    idempotencyKey: string,
  ): Promise<(StoredDelivery & { id: string }) | null> {
    return this.prisma.delivery.findUnique({
      where: {
        businessId_client_submission_id: {
          businessId,
          client_submission_id: idempotencyKey,
        },
      },

      // Exactly what the create writes from the request, and nothing it
      // does not: the status, the driver or the route moving later is not
      // the caller's body changing.
      select: {
        id: true,
        shipperId: true,
        code: true,
        invoice_key: true,
        invoice_number: true,
        recipient_name: true,
        recipient_document: true,
        recipient_email: true,
        recipient_telephone: true,
        cep: true,
        city: true,
        uf: true,
        street: true,
        address_number: true,
        complement: true,
        neighborhood: true,
        scheduled_date: true,
        notes: true,
        // Whether an API key made it: the panel's submissions are not replayed.
        apiKeyId: true,
        items: {
          select: {
            description: true,
            quantity: true,
            unit: true,
            unit_value: true,
          },
        },
      },
    });
  }
}

export { IntegrationRepository, cursorPage, eventIdFloor };
