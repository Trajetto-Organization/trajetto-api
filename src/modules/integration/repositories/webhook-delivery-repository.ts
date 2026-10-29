import { Prisma, WebhookDeliveryStatus } from "@prisma/client";

import database from "@/../infra/database";

import { buildResendRow } from "@/shared/integration/webhook-resend";
import {
  releaseHeldRowIfEndpointBack,
  releaseParkedWebhookDeliveries,
} from "@/shared/integration/webhook-dispatch-service";

import type {
  IWebhookDeliveryRepository,
  ResendableDelivery,
  WebhookMonitorPage,
  WebhookMonitorQuery,
} from "./IWebhook-delivery-repository";

const IN_FLIGHT = {
  status: {
    in: [WebhookDeliveryStatus.PENDING, WebhookDeliveryStatus.PROCESSING],
  },
};

const SETTLED = [WebhookDeliveryStatus.DELIVERED, WebhookDeliveryStatus.FAILED];

class WebhookDeliveryRepository implements IWebhookDeliveryRepository {
  constructor(private prisma = database) {}

  async monitor(query: WebhookMonitorQuery): Promise<WebhookMonitorPage> {
    const { businessId, since } = query;

    const endpointFilter = query.endpointId
      ? { endpointId: query.endpointId }
      : {};

    const settledInWindow = (statuses: WebhookDeliveryStatus[]) => ({
      status: { in: statuses },
      created_at: { gte: since },
    });

    // One window for the cards and the list (DLVB-29): settled rows count by
    // when the event was created, the queue whatever its age. "Na fila" is
    // PENDING and PROCESSING, on the chip as on the card (DLVB-28).
    const statusWhere: Prisma.WebhookDeliveryWhereInput =
      query.status === "QUEUED"
        ? IN_FLIGHT
        : query.status === "PENDING" || query.status === "PROCESSING"
          ? { status: query.status }
          : query.status === "DELIVERED" || query.status === "FAILED"
            ? settledInWindow([query.status])
            : { OR: [IN_FLIGHT, settledInWindow(SETTLED)] };

    const where: Prisma.WebhookDeliveryWhereInput = {
      businessId,
      ...endpointFilter,
      ...statusWhere,
    };

    // Two at a time — the page beside its count, then the cards, then the
    // p95 — so one monitor holds at most two of the replica's ten
    // connections (tests/E2E/connection-fan-out.test.ts); it took five.
    const [rows, counted] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          topic: true,
          status: true,
          attempts: true,
          response_status: true,
          response_body: true,
          latency_ms: true,
          lastError: true,
          deliveredAt: true,
          availableAt: true,
          leaseExpiresAt: true,
          created_at: true,
          endpoint: { select: { id: true, name: true, url: true } },
        },
      }),

      // Stops one row past the cap (COUNT over a LIMITed subquery), so a
      // big tenant's month costs the same as a small one's. The order is the
      // page's: without it Prisma orders the subquery by id, which no
      // (businessId, …) index serves, so the cap only stopped the walk after
      // every row of the company — or of the whole table, by primary key.
      this.prisma.webhookDelivery.count({
        where,
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: query.cap + 1,
      }),
    ]);

    const [counts, queued] = await Promise.all([
      // The statuses are named so each one is a tight range on
      // (businessId, status, created_at).
      this.prisma.webhookDelivery.groupBy({
        by: ["status"],
        where: { businessId, ...endpointFilter, ...settledInWindow(SETTLED) },
        _count: { _all: true },
      }),

      this.prisma.webhookDelivery.count({
        where: { businessId, ...endpointFilter, ...IN_FLIGHT },
      }),
    ]);

    // Over the same rows "Entregues" counts (DLVB-31); percentile_disc is
    // the nearest-rank percentile, an actual observed latency.
    const latency = query.endpointId
      ? await this.prisma.$queryRaw<Array<{ p95: number | null }>>`
          SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY "latency_ms") AS "p95"
          FROM "webhook_delivery"
          WHERE "businessId" = ${businessId}
            AND "endpointId" = ${query.endpointId}
            AND "status" = 'DELIVERED'
            AND "created_at" >= ${since}
            AND "latency_ms" IS NOT NULL
        `
      : await this.prisma.$queryRaw<Array<{ p95: number | null }>>`
          SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY "latency_ms") AS "p95"
          FROM "webhook_delivery"
          WHERE "businessId" = ${businessId}
            AND "status" = 'DELIVERED'
            AND "created_at" >= ${since}
            AND "latency_ms" IS NOT NULL
        `;

    const countOf = (status: WebhookDeliveryStatus) =>
      counts.find((entry) => entry.status === status)?._count._all ?? 0;

    const p95 = latency[0]?.p95;

    return {
      rows,
      counted,
      delivered: countOf(WebhookDeliveryStatus.DELIVERED),
      failed: countOf(WebhookDeliveryStatus.FAILED),
      queued,
      p95LatencyMs: p95 === null || p95 === undefined ? null : Number(p95),
    };
  }

  async findForResend(
    id: string,
    businessId: string,
  ): Promise<ResendableDelivery | null> {
    return this.prisma.webhookDelivery.findFirst({
      where: { id, businessId },
      include: { endpoint: { select: { is_active: true, disabled_at: true } } },
    });
  }

  async createResend(
    original: ResendableDelivery,
    held: { availableAt: Date; lastError: string } | null,
  ): Promise<{ id: string }> {
    return this.prisma.webhookDelivery.create({
      data: { ...buildResendRow(original), ...(held ?? {}) },
      select: { id: true },
    });
  }

  async releaseParked(endpointId: string): Promise<number> {
    return releaseParkedWebhookDeliveries(endpointId, this.prisma);
  }

  async releaseHeldIfEndpointBack(
    rowId: string,
    endpointId: string,
  ): Promise<void> {
    await releaseHeldRowIfEndpointBack(rowId, endpointId);
  }
}

export { WebhookDeliveryRepository };
