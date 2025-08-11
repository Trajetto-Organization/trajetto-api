import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListFuelBusinessUseCase } from "./list-fuel-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListFuelBusinessController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, page, pageSize } = request.query as z.infer<
      typeof listPagesByBusinessSchema
    >;

    const listFuelBusinessUseCase = container.resolve(ListFuelBusinessUseCase);

    try {
      const fuelsPromise = listFuelBusinessUseCase.execute(
        {
          businessId,
          page,
          pageSize,
        },
        id,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: fuelsPromise,
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

export { ListFuelBusinessController };
