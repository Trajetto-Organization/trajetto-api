import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IApiKeyRepository } from "../../repositories/IApi-key-repository";
import type {
  IWebhookDeliveryRepository,
  MonitorStatusFilter,
  WebhookMonitorRow,
} from "../../repositories/IWebhook-delivery-repository";

import { AppError } from "@/shared/errors/AppError";
import { apiUsageWindow } from "@/shared/integration/api-usage-window";
import { dateOnlyKey, resolveTimeZone } from "@/shared/time/business-day";
import {
  ENDPOINT_PAUSED_REASON,
  REPLAY_WINDOW_DAYS,
  parkedUntil,
} from "@/shared/integration/webhook-dispatch-rules";
import {
  MONITOR_LIST_CAP,
  MONITOR_WINDOW_MS,
  type MONITOR_WINDOWS,
} from "@/schemas/integration-schema";

import { scopedBusiness } from "./integration-admin-access";

type MonitorWindow = (typeof MONITOR_WINDOWS)[number];

interface ListWebhookDeliveriesRequest {
  userId: string;
  businessId: string;
  page: number;
  pageSize: number;
  status?: MonitorStatusFilter;
  window?: MonitorWindow;
  endpointId?: string;
}

interface WebhookDeliveriesPage {
  data: WebhookMonitorRow[];
  total: number;
  meta: {
    window: MonitorWindow;
    totalCapped: boolean;
    delivered: number;
    failed: number;
    pending: number;
    p95LatencyMs: number | null;
  };
}

/** The monitor: what we sent, what the receiver answered, and the cards. */
@injectable()
class ListWebhookDeliveriesUseCase {
  constructor(
    @inject("WebhookDeliveryRepository")
    private deliveries: IWebhookDeliveryRepository,
    @inject("UserRepository") private users: IUserRepository,
  ) {}

  async execute(
    request: ListWebhookDeliveriesRequest,
    now: Date = new Date(),
  ): Promise<WebhookDeliveriesPage> {
    await scopedBusiness(this.users, request.userId, request.businessId);

    // The list pages only as far as it counts: an OFFSET of a million rows
    // walks a million index entries to throw them away.
    if ((request.page - 1) * request.pageSize >= MONITOR_LIST_CAP) {
      throw new AppError(
        `A lista mostra os primeiros ${MONITOR_LIST_CAP.toLocaleString("pt-BR")} envios. Filtre por status, endpoint ou período para ver os demais.`,
        400,
        "MONITOR_PAGE_OUT_OF_RANGE",
      );
    }

    const window = request.window ?? "24h";

    const page = await this.deliveries.monitor({
      businessId: request.businessId,
      endpointId: request.endpointId,
      status: request.status,
      since: new Date(now.getTime() - MONITOR_WINDOW_MS[window]),
      page: request.page,
      pageSize: request.pageSize,
      cap: MONITOR_LIST_CAP,
    });

    return {
      data: page.rows,
      total: Math.min(page.counted, MONITOR_LIST_CAP),
      meta: {
        window,
        // `total` is a floor, not the count: the screen says "mais de".
        totalCapped: page.counted > MONITOR_LIST_CAP,
        delivered: page.delivered,
        failed: page.failed,
        pending: page.queued,
        p95LatencyMs: page.p95LatencyMs,
      },
    };
  }
}

/**
 * Queues the event again — a NEW row with the same bytes and signature.
 * Past the replay window it refuses in a sentence; while the endpoint is
 * paused or switched off, it is accepted but held with the endpoint's other
 * events, and the sentence says so.
 */
@injectable()
class ResendWebhookDeliveryUseCase {
  constructor(
    @inject("WebhookDeliveryRepository")
    private deliveries: IWebhookDeliveryRepository,
    @inject("UserRepository") private users: IUserRepository,
  ) {}

  async execute(
    userId: string,
    businessId: string,
    id: string,
    now: Date = new Date(),
  ): Promise<{ id: string; held: boolean }> {
    await scopedBusiness(this.users, userId, businessId);

    const original = await this.deliveries.findForResend(id, businessId);

    if (!original) {
      throw new AppError(
        "Entrega de webhook não encontrada.",
        404,
        "WEBHOOK_DELIVERY_NOT_FOUND",
      );
    }

    const windowStart =
      now.getTime() - REPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    if (original.created_at.getTime() < windowStart) {
      throw new AppError(
        `Este evento tem mais de ${REPLAY_WINDOW_DAYS} dias e está fora da janela de reenvio.`,
        409,
        "OUTSIDE_REPLAY_WINDOW",
      );
    }

    const held =
      !original.endpoint.is_active || original.endpoint.disabled_at !== null;

    const resent = await this.deliveries.createResend(
      original,
      held
        ? { availableAt: parkedUntil(now), lastError: ENDPOINT_PAUSED_REASON }
        : null,
    );

    // Saved active again since the read above? Its release did not see
    // this row yet.
    if (held) {
      await this.deliveries.releaseHeldIfEndpointBack(
        resent.id,
        original.endpointId,
      );
    }

    return { id: resent.id, held };
  }
}

interface ApiUsageReport {
  totals: { ok: number; clientError: number; serverError: number };
  byRoute: Array<{
    method: string;
    route: string;
    ok: number;
    clientError: number;
    serverError: number;
  }>;
  byDay: Array<{ day: string; total: number }>;
  keys: Array<{ id: string; name: string; prefix: string }>;
  timeZone: string;
}

/**
 * What the customer's system asked of us, off the daily aggregate, in the
 * company's calendar: the recorder buckets calls by the business day.
 */
@injectable()
class ListApiUsageUseCase {
  constructor(
    @inject("ApiKeyRepository") private apiKeys: IApiKeyRepository,
    @inject("UserRepository") private users: IUserRepository,
  ) {}

  async execute(
    request: {
      userId: string;
      businessId: string;
      days: number;
      apiKeyId?: string;
    },
    now: Date = new Date(),
  ): Promise<ApiUsageReport> {
    await scopedBusiness(this.users, request.userId, request.businessId);

    const timeZone = resolveTimeZone(
      await this.apiKeys.businessTimeZone(request.businessId),
    );
    const { since, dayKeys } = apiUsageWindow(now, timeZone, request.days);

    const rows = await this.apiKeys.listUsage({
      businessId: request.businessId,
      since,
      apiKeyId: request.apiKeyId,
    });

    const byRoute = new Map<string, ApiUsageReport["byRoute"][number]>();
    const totals = { ok: 0, clientError: 0, serverError: 0 };

    // BigInt does not survive JSON: converted here, once.
    for (const row of rows) {
      const key = `${row.method} ${row.route}`;
      const entry = byRoute.get(key) ?? {
        method: row.method,
        route: row.route,
        ok: 0,
        clientError: 0,
        serverError: 0,
      };
      const amount = Number(row.count);

      if (row.status_class === 2) {
        entry.ok += amount;
        totals.ok += amount;
      } else if (row.status_class === 4) {
        entry.clientError += amount;
        totals.clientError += amount;
      } else {
        entry.serverError += amount;
        totals.serverError += amount;
      }

      byRoute.set(key, entry);
    }

    // A day with no calls is a fact: a chart that omits it draws a line
    // straight over a weekend the integration was down.
    const byDay = new Map(dayKeys.map((day) => [day, { day, total: 0 }]));

    for (const row of rows) {
      // The DATE column comes back as UTC midnight of the civil day.
      const entry = byDay.get(dateOnlyKey(row.day));

      if (entry) entry.total += Number(row.count);
    }

    const keys = new Map<
      string,
      { id: string; name: string; prefix: string }
    >();

    for (const row of rows) {
      if (row.apiKey) keys.set(row.apiKey.id, row.apiKey);
    }

    const volume = (entry: ApiUsageReport["byRoute"][number]) =>
      entry.ok + entry.clientError + entry.serverError;

    return {
      totals,
      byRoute: [...byRoute.values()].sort(
        (left, right) => volume(right) - volume(left),
      ),
      byDay: [...byDay.values()],
      keys: [...keys.values()],
      timeZone,
    };
  }
}

export {
  ListApiUsageUseCase,
  ListWebhookDeliveriesUseCase,
  ResendWebhookDeliveryUseCase,
};
export type {
  ApiUsageReport,
  ListWebhookDeliveriesRequest,
  WebhookDeliveriesPage,
};
