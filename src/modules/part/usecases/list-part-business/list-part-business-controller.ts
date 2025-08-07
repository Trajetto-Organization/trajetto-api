import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListPartBusinessUseCase } from "./list-part-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListPartBusinessController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { page, pageSize, businessId } = request.query as z.infer<
      typeof listPagesByBusinessSchema
    >;

    const listPartBusinessUseCase = container.resolve(ListPartBusinessUseCase);

    try {
      const partBusinessList = listPartBusinessUseCase.execute(
        id,
        page,
        pageSize,
        businessId,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: partBusinessList,
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

export { ListPartBusinessController };
