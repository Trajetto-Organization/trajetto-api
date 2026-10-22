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
import { OperationSummary } from "../../dtos/delivery-dto";

import { readOperationSummary } from "./read-operation-summary";

interface OperationSummaryRequest {
  userId: string;
  businessId?: string;
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
  }: OperationSummaryRequest): Promise<OperationSummary> {
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

      return await readOperationSummary(
        { operation: this.operation, delivery: this.delivery },
        resolvedBusinessId,
        operationDay(timeZone, new Date()),
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Não foi possível montar o resumo da operação!", 500);
    }
  }
}

export { OperationSummaryUseCase };
