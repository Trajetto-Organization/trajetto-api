import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { ListVehicleChecklistBusinessUseCase } from "./list-vehicle-checklist-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import {
  listVehicleChecklistBusinessSchema,
  listVehicleChecklistBusinessQuerySchema,
} from "@/schemas/list-vehicle-checklist-business-schema";

class ListVehicleChecklistBusinessController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id: userId, role: currentUserRole } = request.user;

    const { businessId } = listVehicleChecklistBusinessSchema.parse(
      request.params,
    );

    const query = listVehicleChecklistBusinessQuerySchema.parse(request.query);
    const listVehicleChecklistBusinessUseCase = container.resolve(
      ListVehicleChecklistBusinessUseCase,
    );

    try {
      const checklists = await listVehicleChecklistBusinessUseCase.execute({
        page: query.page,
        pageSize: query.pageSize,
        businessId,
        currentUserRole,
        search: query.search,
        vehicleId: query.vehicleId,
        driverId: query.driverId,
        overall_condition: query.overall_condition,
        startDate: query.startDate,
        endDate: query.endDate,
        userId,
      });

      return reply.status(200).send(checklists);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListVehicleChecklistBusinessController };
