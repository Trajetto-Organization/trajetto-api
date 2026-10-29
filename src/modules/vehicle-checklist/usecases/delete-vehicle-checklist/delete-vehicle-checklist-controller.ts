import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { DeleteVehicleChecklistUseCase } from "./delete-vehicle-checklist-usecase";

import { replyChecklistError } from "../errors/vehicle-checklist-http-errors";
import { updateDeleteVehicleChecklistSchema } from "@/schemas/update-delete-vehicle-checklist-schema";

class DeleteVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id: userId } = request.user;

    const { businessId, checklistId } =
      updateDeleteVehicleChecklistSchema.parse(request.params);

    const deleteVehicleChecklistUseCase = container.resolve(
      DeleteVehicleChecklistUseCase,
    );

    try {
      await deleteVehicleChecklistUseCase.execute({
        checklistId,
        businessId,
        userId,
      });

      return reply.status(200).send({
        message: "Checklist veicular excluído com sucesso!",
      });
    } catch (error) {
      // 404 VEHICLE_CHECKLIST_NOT_FOUND also for another company's id; every
      // refusal carries a code (vehicle-checklist-http-errors).
      if (replyChecklistError(reply, error)) return;

      throw error;
    }
  }
}

export { DeleteVehicleChecklistController };
