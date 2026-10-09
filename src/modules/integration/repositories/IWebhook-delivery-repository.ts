import type { WebhookDelivery, WebhookDeliveryStatus } from "@prisma/client";

/** The monitor's status chip: "QUEUED" is PENDING and PROCESSING together. */
type MonitorStatusFilter =
  | "QUEUED"
  | "PENDING"
  | "PROCESSING"
  | "DELIVERED"
  | "FAILED";

interface WebhookMonitorQuery {
  businessId: string;
  endpointId?: string;
  status?: MonitorStatusFilter;
  /** Settled rows count from here (created_at); the queue counts whatever its age. */
  since: Date;
  page: number;
  pageSize: number;
  /** The count stops one row past it. */
  cap: number;
}

interface WebhookMonitorRow {
  id: string;
  topic: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  response_status: number | null;
  response_body: string | null;
  latency_ms: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  created_at: Date;
  endpoint: { id: string; name: string; url: string };
}

interface WebhookMonitorPage {
  rows: WebhookMonitorRow[];
  /** At most `cap + 1`. */
  counted: number;
  delivered: number;
  failed: number;
  /** PENDING and PROCESSING, whatever their age. */
  queued: number;
  /** Nearest-rank p95 of the delivered rows' latency in the period. */
  p95LatencyMs: number | null;
}

type ResendableDelivery = WebhookDelivery & {
  endpoint: { is_active: boolean; disabled_at: Date | null };
};

/**
 * The webhook deliveries of a company (TEST-ARCH-1): the monitor's reads and
 * the manual resend. Scoped by `businessId` like every other read.
 */
interface IWebhookDeliveryRepository {
  monitor: (query: WebhookMonitorQuery) => Promise<WebhookMonitorPage>;

  findForResend: (
    id: string,
    businessId: string,
  ) => Promise<ResendableDelivery | null>;

  /**
   * Queues a NEW row with the original's bytes and signature (see
   * buildResendRow); `held` parks it while the endpoint is off.
   */
  createResend: (
    original: ResendableDelivery,
    held: { availableAt: Date; lastError: string } | null,
  ) => Promise<{ id: string }>;

  /**
   * Sends now what an endpoint held while it was off, within the replay
   * window; the number of rows released.
   */
  releaseParked: (endpointId: string) => Promise<number>;

  /** Releases one held row when its endpoint is back on since it was read. */
  releaseHeldIfEndpointBack: (rowId: string, endpointId: string) => Promise<void>;
}

export type {
  IWebhookDeliveryRepository,
  MonitorStatusFilter,
  ResendableDelivery,
  WebhookMonitorPage,
  WebhookMonitorQuery,
  WebhookMonitorRow,
};
