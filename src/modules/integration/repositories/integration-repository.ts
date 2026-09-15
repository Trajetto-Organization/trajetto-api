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
    const rows = await this.prisma.deliveryEvent.findMany({
      where: {
        delivery: { businessId },
        ...(updated_since && { created_at: { gte: new Date(updated_since) } }),
      },

      select: {
        id: true,
        type: true,
        created_at: true,
        status_from: true,
        status_to: true,
        received_by: true,
        note: true,

        delivery: { select: { id: true, code: true, invoice_key: true } },
      },

      orderBy: { id: "asc" },

      take: limit + 1,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
    });

    const { page, next_cursor } = cursorPage(rows, limit);

    return {
      data: page.map((event) => ({
        id: event.id,

        // The public name, not the column. `PROOF` is an internal word; the
        // catalogue says `proof.registered` and that is what a subscriber
        // matched on.
        topic:
          event.type === "PROOF"
            ? "proof.registered"
            : event.type === "ARRIVAL"
              ? "delivery.arrived"
              : event.type === "STATUS_CHANGE"
                ? `delivery.${(event.status_to ?? "").toLowerCase()}`
                : "delivery.note",

        occurred_at: toIso(event.created_at)!,

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
}

export { IntegrationRepository, cursorPage };
