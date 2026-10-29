import { randomUUID } from "node:crypto";

import { WebhookDeliveryStatus, type WebhookDelivery } from "@prisma/client";

import { buildResendRow } from "@/shared/integration/webhook-resend";
import {
  ENDPOINT_PAUSED_REASON,
  REPLAY_WINDOW_DAYS,
} from "@/shared/integration/webhook-dispatch-rules";

import type {
  IWebhookDeliveryRepository,
  ResendableDelivery,
  WebhookMonitorPage,
  WebhookMonitorQuery,
} from "../IWebhook-delivery-repository";
import type { InMemoryWebhookEndpointRepository } from "./in-memory-webhook-endpoint-repository";

const SETTLED: WebhookDeliveryStatus[] = [
  WebhookDeliveryStatus.DELIVERED,
  WebhookDeliveryStatus.FAILED,
];

const IN_FLIGHT: WebhookDeliveryStatus[] = [
  WebhookDeliveryStatus.PENDING,
  WebhookDeliveryStatus.PROCESSING,
];

/** percentile_disc: the smallest observed value at or above the fraction. */
function percentileDisc(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);

  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

/**
 * The twin of WebhookDeliveryRepository. It reads the endpoints of its
 * endpoint twin, so a delivery of a deleted endpoint is gone (the foreign
 * key cascades in the database), and it applies the same window, status and
 * company filters, order and cap as the Prisma queries.
 */
class InMemoryWebhookDeliveryRepository implements IWebhookDeliveryRepository {
  constructor(
    private endpoints: InMemoryWebhookEndpointRepository,
    public deliveries: WebhookDelivery[] = [],
    private now: () => Date = () => new Date(),
  ) {}

  private live(): WebhookDelivery[] {
    const ids = new Set(
      this.endpoints.endpoints.map((endpoint) => endpoint.id),
    );

    return this.deliveries.filter((delivery) => ids.has(delivery.endpointId));
  }

  async monitor(query: WebhookMonitorQuery): Promise<WebhookMonitorPage> {
    const scoped = this.live().filter(
      (row) =>
        row.businessId === query.businessId &&
        (!query.endpointId || row.endpointId === query.endpointId),
    );

    const inWindow = (row: WebhookDelivery) =>
      row.created_at.getTime() >= query.since.getTime();

    const matches = (row: WebhookDelivery): boolean => {
      switch (query.status) {
        case "QUEUED":
          return IN_FLIGHT.includes(row.status);
        case "PENDING":
        case "PROCESSING":
          return row.status === query.status;
        case "DELIVERED":
        case "FAILED":
          return row.status === query.status && inWindow(row);
        default:
          return (
            IN_FLIGHT.includes(row.status) ||
            (SETTLED.includes(row.status) && inWindow(row))
          );
      }
    };

    const listed = scoped
      .filter(matches)
      .sort(
        (left, right) =>
          right.created_at.getTime() - left.created_at.getTime() ||
          (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
      );

    const start = (query.page - 1) * query.pageSize;

    const rows = listed.slice(start, start + query.pageSize).map((row) => {
      const endpoint = this.endpoints.endpoints.find(
        (candidate) => candidate.id === row.endpointId,
      )!;

      return {
        id: row.id,
        topic: row.topic,
        status: row.status,
        attempts: row.attempts,
        response_status: row.response_status,
        response_body: row.response_body,
        latency_ms: row.latency_ms,
        lastError: row.lastError,
        deliveredAt: row.deliveredAt,
        availableAt: row.availableAt,
        leaseExpiresAt: row.leaseExpiresAt,
        created_at: row.created_at,
        endpoint: { id: endpoint.id, name: endpoint.name, url: endpoint.url },
      };
    });

    const settled = scoped.filter(
      (row) => SETTLED.includes(row.status) && inWindow(row),
    );

    const latencies = scoped
      .filter(
        (row) =>
          row.status === WebhookDeliveryStatus.DELIVERED &&
          inWindow(row) &&
          row.latency_ms !== null,
      )
      .map((row) => row.latency_ms as number);

    return {
      rows,
      counted: Math.min(listed.length, query.cap + 1),
      delivered: settled.filter(
        (row) => row.status === WebhookDeliveryStatus.DELIVERED,
      ).length,
      failed: settled.filter(
        (row) => row.status === WebhookDeliveryStatus.FAILED,
      ).length,
      queued: scoped.filter((row) => IN_FLIGHT.includes(row.status)).length,
      p95LatencyMs: percentileDisc(latencies, 0.95),
    };
  }

  async findForResend(
    id: string,
    businessId: string,
  ): Promise<ResendableDelivery | null> {
    const row = this.live().find(
      (candidate) => candidate.id === id && candidate.businessId === businessId,
    );

    if (!row) return null;

    const endpoint = this.endpoints.endpoints.find(
      (candidate) => candidate.id === row.endpointId,
    )!;

    return {
      ...row,
      endpoint: {
        is_active: endpoint.is_active,
        disabled_at: endpoint.disabled_at,
      },
    };
  }

  async createResend(
    original: ResendableDelivery,
    held: { availableAt: Date; lastError: string } | null,
  ): Promise<{ id: string }> {
    const data = buildResendRow(original);
    const now = this.now();

    const row: WebhookDelivery = {
      id: randomUUID(),
      endpointId: data.endpointId,
      businessId: data.businessId,
      topic: data.topic,
      sourceEventId: data.sourceEventId ?? null,
      payload: data.payload as WebhookDelivery["payload"],
      signature: data.signature,
      signed_body: data.signed_body ?? null,
      status: WebhookDeliveryStatus.PENDING,
      attempts: 0,
      availableAt: held?.availableAt ?? now,
      leaseExpiresAt: null,
      response_status: null,
      response_body: null,
      latency_ms: null,
      deliveredAt: null,
      lastError: held?.lastError ?? null,
      resent_from_id: data.resent_from_id ?? null,
      created_at: now,
      updated_at: now,
    };

    this.deliveries.push(row);

    return { id: row.id };
  }

  async releaseParked(endpointId: string): Promise<number> {
    const endpoint = this.endpoints.endpoints.find(
      (candidate) => candidate.id === endpointId,
    );

    if (!endpoint) return 0;

    const now = this.now();
    const from = now.getTime() - REPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    let released = 0;

    for (const row of this.deliveries) {
      if (
        row.endpointId === endpointId &&
        row.businessId === endpoint.businessId &&
        row.status === WebhookDeliveryStatus.PENDING &&
        row.created_at.getTime() >= from &&
        row.availableAt.getTime() > now.getTime()
      ) {
        row.availableAt = now;
        if (row.lastError === ENDPOINT_PAUSED_REASON) row.lastError = null;
        released += 1;
      }
    }

    return released;
  }

  async releaseHeldIfEndpointBack(
    rowId: string,
    endpointId: string,
  ): Promise<void> {
    const endpoint = this.endpoints.endpoints.find(
      (candidate) => candidate.id === endpointId,
    );

    if (!endpoint?.is_active || endpoint.disabled_at !== null) return;

    const row = this.deliveries.find(
      (candidate) =>
        candidate.id === rowId &&
        candidate.status === WebhookDeliveryStatus.PENDING &&
        candidate.lastError === ENDPOINT_PAUSED_REASON,
    );

    if (row) {
      row.availableAt = this.now();
      row.lastError = null;
    }
  }
}

export { InMemoryWebhookDeliveryRepository };
