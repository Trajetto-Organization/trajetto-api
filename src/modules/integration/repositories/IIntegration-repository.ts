import type {
  PublicDelivery,
  PublicRoute,
} from "@/shared/integration/public-shapes";

import type { StoredDelivery } from "../usecases/create-delivery/replay-fingerprint";

interface CursorPage<T> {
  data: T[];

  /** Null when this is the last page. */
  next_cursor: string | null;
}

interface IntegrationListProps {
  businessId: string;

  limit: number;
  cursor?: string;

  updated_since?: string;
  status?: string;
}

/**
 * What an outside system can read.
 *
 * Cursor paging on everything, and the cursor is the row id: an ERP pulling a
 * customer's whole operation walks hundreds of pages, `OFFSET 40000` makes
 * Postgres count forty thousand rows to throw them away, and — the part that
 * actually loses data — an offset page shifts when a row is inserted mid-walk,
 * so an integration silently skips a delivery.
 */
interface IIntegrationRepository {
  listDeliveries: (
    props: IntegrationListProps,
  ) => Promise<CursorPage<PublicDelivery>>;

  findDelivery: (
    businessId: string,
    deliveryId: string,
  ) => Promise<PublicDelivery | null>;

  listRoutes: (props: IntegrationListProps) => Promise<CursorPage<PublicRoute>>;

  findRoute: (
    businessId: string,
    routeId: string,
  ) => Promise<PublicRoute | null>;

  /**
   * The feed of what happened, for an integration that polls instead of
   * subscribing.
   *
   * Offered alongside the webhooks and not instead of them: a customer behind
   * a firewall cannot receive a call, and telling them "expose an endpoint or
   * get nothing" is how an integration project dies.
   */
  listEvents: (props: IntegrationListProps) => Promise<
    CursorPage<{
      id: string;
      topic: string;
      occurred_at: string;
      delivery: { id: string; code: string | null; invoice_key: string | null };
      data: Record<string, unknown>;
    }>
  >;

  /**
   * The delivery a create with this Idempotency-Key already made in this
   * company, in the fields the create wrote — what a retry is compared with
   * (decision 5.10). The unique (businessId, client_submission_id) index
   * answers it.
   */
  findSubmission: (
    businessId: string,
    idempotencyKey: string,
  ) => Promise<(StoredDelivery & { id: string }) | null>;
}

export type { CursorPage, IIntegrationRepository, IntegrationListProps };
