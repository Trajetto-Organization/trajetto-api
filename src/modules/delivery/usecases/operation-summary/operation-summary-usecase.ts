import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import type { IOperationDayRepository } from "@/modules/route/repositories/IOperation-day-repository";

import {
  PANEL_DRIVER_REFUSAL,
  resolveOperationsBusiness,
} from "@/modules/route/usecases/control-tower/operations-viewer";

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
    // The driver permission table opens delivery_manage for the app's own
    // routes; the whole-operation view stays with the manager. The same
    // gate as the tower's boards: 404, driver 403, no company 400, tenant.
    const resolvedBusinessId = await resolveOperationsBusiness(this.user, {
      userId,
      businessId,
      driverRefusal: PANEL_DRIVER_REFUSAL,
    });

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

export { OperationSummaryUseCase };
export type { OperationSummaryResult };
