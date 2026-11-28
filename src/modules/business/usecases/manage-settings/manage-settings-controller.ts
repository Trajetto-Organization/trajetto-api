import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import {
  GetBusinessSettingsUseCase,
  UpdateBusinessSettingsUseCase,
} from "./manage-settings-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateBusinessSettingsSchema } from "@/schemas/business-settings-schema";

class GetBusinessSettingsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const useCase = container.resolve(GetBusinessSettingsUseCase);
    const data = await useCase.execute({ userId: id, businessId });

    return reply.status(200).send({ data });
  }
}

class UpdateBusinessSettingsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const {
      checklist_requirement,
      arrival_geofence_mode,
      arrival_geofence_radius_m,
    } = updateBusinessSettingsSchema.parse(request.body);

    const useCase = container.resolve(UpdateBusinessSettingsUseCase);
    const data = await useCase.execute({
      userId: id,
      businessId,
      data: {
        checklist_requirement,
        arrival_geofence_mode,
        arrival_geofence_radius_m,
      },
    });

    return reply.status(200).send({
      message: "Configurações da empresa salvas com sucesso!",
      data,
    });
  }
}

export { GetBusinessSettingsController, UpdateBusinessSettingsController };
