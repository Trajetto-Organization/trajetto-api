import { FastifyReply, FastifyRequest } from "fastify";

import { container } from "tsyringe";
import { z } from "zod";

import { ListProfileBusinessUseCase } from "./list-profile-business-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListProfileBusinessController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { page, pageSize, businessId } = request.query as z.infer<
      typeof listPagesByBusinessSchema
    >;

    const listProfileBusinessUseCase = container.resolve(
      ListProfileBusinessUseCase,
    );

    try {
      const listProfileBusiness = listProfileBusinessUseCase.execute(
        id,
        page,
        pageSize,
        businessId,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: listProfileBusiness,
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

export { ListProfileBusinessController };
