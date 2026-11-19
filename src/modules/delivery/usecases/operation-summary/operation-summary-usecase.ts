import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import type { IOperationDayRepository } from "@/modules/route/repositories/IOperation-day-repository";

import {
  PANEL_DRIVER_REFUSAL,
  resolveOperationsBusiness,
} from "@/modules/route/usecases/control-tower/operations-viewer";
import {
  towerSnapshot,
  type SnapshotBody,
} from "@/modules/route/usecases/control-tower/tower-snapshot";
import type { TenantSnapshotRead } from "@/shared/cache/tenant-snapshot";

import { AppError } from "@/shared/errors/AppError";
import { operationDay } from "@/shared/route/operation-day-rules";
import {
  inheritedOpenStops,
  leftOpenStartedBefore,
  type InheritedOpenStops,
} from "@/shared/route/route-left-open";
import { resolveTimeZone } from "@/shared/time/business-day";
import { OperationSummary } from "../../dtos/delivery-dto";

import { readOperationSummary } from "./read-operation-summary";

interface OperationSummaryRequest {
  userId: string;
  businessId?: string;
}

interface OperationSummarySnapshotRequest extends OperationSummaryRequest {
  /** x-trajetto-refresh: a read newer than the copy, if it is 2 s old. */
  refresh: boolean;

  /** The route's serializer: the summary becomes the body it would send. */
  body: SnapshotBody<OperationSummaryResult>;
}

/**
 * The summary, plus what its "Em rota" inherited from routes left open
 * (plan of 02/11/2026, H3): the note "inclui N de rotas abertas desde
 * dd/mm" on the Rotas tab, with the tower's own reading of it.
 */
interface OperationSummaryResult extends OperationSummary {
  inherited: InheritedOpenStops;
}

/**
 * The monitoring panel's numbers: what the dispatcher still owes a route,
 * who is on the street, what the day produced. Manager surface — a driver
 * token is refused rather than shown the whole operation.
 *
 * "The day" is the company's business day, in `Business.timezone`: the
 * server's midnight (UTC in the container) reset every counter at 21:00 in
 * São Paulo (DLVP-OPS-1). Its documents are the tower's (decision 7.1).
 */
/**
 * The summary of each company, once per TOWER_SNAPSHOT_TTL_MS in this
 * process (plano-escala F4-11): the Rotas tab polls it beside the tower.
 */
const operationSummarySnapshot = towerSnapshot("operation-summary");

@injectable()
class OperationSummaryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("OperationDayRepository")
    private operation: IOperationDayRepository,
  ) {}

  async execute({
    userId,
    businessId,
  }: OperationSummaryRequest): Promise<OperationSummaryResult> {
    return this.build(await this.resolve(userId, businessId));
  }

  /**
   * The summary through the company's snapshot (F4-11): the same checks, on
   * every request and before the snapshot is looked at, then the body of
   * the company's copy, computed once per interval outside this request.
   */
  async executeSnapshot({
    userId,
    businessId,
    refresh,
    body,
  }: OperationSummarySnapshotRequest): Promise<TenantSnapshotRead> {
    const resolvedBusinessId = await this.resolve(userId, businessId);

    return operationSummarySnapshot.read({
      businessId: resolvedBusinessId,
      refresh,
      compute: async () => body(await this.build(resolvedBusinessId)),
    });
  }

  private resolve(userId: string, businessId?: string): Promise<string> {
    // The driver permission table opens delivery_manage for the app's own
    // routes; the whole-operation view stays with the manager. The same
    // gate as the tower's boards: 404, driver 403, no company 400, tenant.
    return resolveOperationsBusiness(this.user, {
      userId,
      businessId,
      driverRefusal: PANEL_DRIVER_REFUSAL,
    });
  }

  /** The company's summary now; nothing in it depends on who asked. */
  private async build(
    resolvedBusinessId: string,
  ): Promise<OperationSummaryResult> {
    try {
      // Null for a company that does not exist: operationDay falls back to
      // the default zone, and the counts come back empty.
      const timeZone = await this.operation.timeZoneOf(resolvedBusinessId);
      const now = new Date();
      const day = operationDay(timeZone, now);

      const summary = await readOperationSummary(
        { operation: this.operation, delivery: this.delivery },
        resolvedBusinessId,
        day,
      );

      // The tower's reading (H3), from the routes left open alone: the
      // running routes that left before leftOpenStartedBefore (exactly the
      // ones isRouteLeftOpen judges forgotten) and their open stops. It used
      // to read the tower's whole day (listTowerRoutes) on every call to keep
      // two routes of it (query-plans.test.ts). After the numbers, never
      // beside them: one connection per request. The dashboard reads the
      // totals only and does not pay for it.
      const leftOpen = await this.operation.listRoutesLeftOpen(
        resolvedBusinessId,
        leftOpenStartedBefore(resolveTimeZone(timeZone), now),
      );

      return {
        ...summary,
        inherited: inheritedOpenStops(leftOpen),
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível montar o resumo da operação!", 500);
    }
  }
}

export { OperationSummaryUseCase, operationSummarySnapshot };
export type { OperationSummaryResult };
