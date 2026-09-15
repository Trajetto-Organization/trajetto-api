import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { AIAnalysisRequestInput } from "@/shared/ai/ai-types";

interface RequestRecordAnalysisRequest {
  userId: string;
  recordType: "fuel" | "checklist";
  recordId: string;
}

interface RequestRecordAnalysisResponse {
  outcome: string;
  message: string;
}

/**
 * The "verificar com IA" button: requests (or re-requests) the AI analysis of
 * an existing fuel/checklist record. Covers records that predate the quota
 * (created while the limit was 0), quota-denied skips and failed runs — the
 * idempotent request layer revives the terminal request without re-billing
 * units that already produced a result.
 *
 * Deliberately manual: enabling AI for a company must not stampede-consume
 * the fresh quota over every historical record.
 */
@injectable()
class RequestRecordAnalysisUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    recordType,
    recordId,
  }: RequestRecordAnalysisRequest): Promise<RequestRecordAnalysisResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    /**
     * O escopo de empresa entra ANTES de qualquer outra recusa.
     *
     * `buildInput` rodava primeiro, e ele tem recusas próprias: "este
     * abastecimento não tem foto do odômetro" é 400, e o registro que não
     * existe é 404. Um chamador com o id de OUTRA empresa distinguia as duas
     * — 400 significava que o registro existe e 404 que não — e isso é um
     * oráculo de existência com a frase pronta.
     */
    const scope =
      findUser.role === "MASTER" ? undefined : (findUser.businessId ?? "");

    const input = await this.buildInput(recordType, recordId, userId, scope);

    const business = await database.business.findUnique({
      where: { id: input.businessId },
      select: { ai_analysis_limit: true },
    });

    if (!business || business.ai_analysis_limit === 0) {
      throw new AppError(
        "A verificação IA não está habilitada para esta empresa.",
        400,
      );
    }

    const outcome = await AIAnalysisService.getInstance().requestAnalysis(input);

    const messages: Record<string, string> = {
      queued: "Verificação IA iniciada.",
      already_running: "A verificação IA já está em andamento.",
      already_completed:
        "Estas fotos já foram verificadas — o resultado está registrado.",
    };

    if (outcome === "denied") {
      throw new AppError("Limite de análises do período atingido.", 400);
    }

    if (outcome === "unavailable") {
      throw new AppError(
        "A verificação IA não está configurada no servidor.",
        400,
      );
    }

    return { outcome, message: messages[outcome] ?? "Verificação IA iniciada." };
  }

  private async buildInput(
    recordType: "fuel" | "checklist",
    recordId: string,
    requestedById: string,

    /**
     * A empresa de quem pediu, ou `undefined` para um MASTER.
     *
     * No `where` e não numa comparação depois: a comparação depois ainda
     * deixa as recusas próprias deste método falarem primeiro, e "este
     * abastecimento não tem foto" contra "não encontrado" é a diferença entre
     * saber e não saber que o registro existe.
     */
    businessId?: string,
  ): Promise<AIAnalysisRequestInput> {
    if (recordType === "fuel") {
      const fuel = await database.fuel.findFirst({
        where: { id: recordId, ...(businessId && { businessId }) },
        select: {
          id: true,
          businessId: true,
          odometer_photo: true,
          current_mileage: true,
        },
      });

      if (!fuel) throw new AppError("Registro não encontrado!", 404);

      if (!fuel.odometer_photo) {
        throw new AppError(
          "Este abastecimento não tem foto do odômetro para verificar.",
          400,
        );
      }

      return {
        type: "FUEL_ODOMETER",
        recordId: fuel.id,
        businessId: fuel.businessId,
        requestedById,
        input: {
          odometerPhotoPath: fuel.odometer_photo,
          reportedMileage: fuel.current_mileage,
        },
      };
    }

    const checklist = await database.vehicleChecklist.findFirst({
      where: { id: recordId, ...(businessId && { businessId }) },
    });

    if (!checklist) throw new AppError("Registro não encontrado!", 404);

    const photosByField =
      (checklist.photos_by_field as Record<string, string[]> | null) ?? {};

    if (Object.keys(photosByField).length === 0) {
      throw new AppError(
        "Este checklist não tem fotos anexadas para verificar.",
        400,
      );
    }

    return {
      type: "CHECKLIST",
      recordId: checklist.id,
      businessId: checklist.businessId,
      requestedById,
      input: {
        photosByField,
        checklistData: checklist as unknown as Record<string, unknown>,
      },
    };
  }
}

export { RequestRecordAnalysisUseCase };
