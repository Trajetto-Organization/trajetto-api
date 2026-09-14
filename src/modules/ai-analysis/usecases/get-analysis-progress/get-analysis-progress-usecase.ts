import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

interface GetAnalysisProgressRequest {
  userId: string;
  recordType: "fuel" | "checklist";
  recordId: string;
}

interface GetAnalysisProgressResponse {
  status:
    | "none"
    | "PENDING"
    | "PROCESSING"
    | "COMPLETED"
    | "PARTIAL"
    | "FAILED"
    | "SKIPPED";
  unitsTotal: number;
  unitsCompleted: number;
  attempts: number;
  availableAt: string | null;
  lastError: string | null;
}

/**
 * Durable progress of the latest AI analysis for a record. The websocket
 * events carry the live progress, but they die with the page — after a
 * refresh this is what lets the details dialog show "3 de 8 fotos" instead
 * of a bare spinner.
 */
@injectable()
class GetAnalysisProgressUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    recordType,
    recordId,
  }: GetAnalysisProgressRequest): Promise<GetAnalysisProgressResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const request = await database.aIAnalysisRequest.findFirst({
      where: {
        type: recordType === "fuel" ? "FUEL_ODOMETER" : "CHECKLIST",
        recordId,
        // Tenant guard: non-MASTER users only see their own company's jobs.
        ...(findUser.role !== "MASTER" && {
          businessId: findUser.businessId ?? "",
        }),
      },
      orderBy: { created_at: "desc" },
      include: { units: { select: { status: true } } },
    });

    if (!request) {
      return {
        status: "none",
        unitsTotal: 0,
        unitsCompleted: 0,
        attempts: 0,
        availableAt: null,
        lastError: null,
      };
    }

    return {
      status: request.status,
      unitsTotal: request.units.length,
      unitsCompleted: request.units.filter(
        (unit) => unit.status === "CONSUMED",
      ).length,
      attempts: request.attempts,
      availableAt: request.availableAt?.toISOString() ?? null,
      lastError: request.lastError,
    };
  }
}

export { GetAnalysisProgressUseCase };
