import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListVehicleChecklistBusinessUseCase } from "./list-vehicle-checklist-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListVehicleChecklistBusinessController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, page, pageSize } = request.query as z.infer<
      typeof listPagesByBusinessSchema
    >;

    const listVehicleChecklistBusinessUseCase = container.resolve(
      ListVehicleChecklistBusinessUseCase,
    );

    try {
      const checklistsPromise = listVehicleChecklistBusinessUseCase.execute(
        {
          businessId,
          page,
          pageSize,
        },
        id,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: checklistsPromise,
        page,
        pageSize,
      });
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
