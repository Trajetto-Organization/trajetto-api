import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListVehicleBusinessUseCase } from "./list-vehicle-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListVehicleBusinessController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { page, pageSize, businessId, search } = request.query as z.infer<
      typeof listPagesByBusinessSchema
    >;

    const listVehicleBusinessUseCase = container.resolve(
      ListVehicleBusinessUseCase,
    );

    try {
      const vehicleBusinessList = listVehicleBusinessUseCase.execute(
        id,
        page,
        pageSize,
        businessId,
        search,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: vehicleBusinessList,
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

export { ListVehicleBusinessController };
