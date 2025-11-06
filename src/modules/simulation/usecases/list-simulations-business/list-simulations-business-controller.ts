import { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { container } from "tsyringe";

import { ListSimulationsBusinessUseCase } from "./list-simulations-business-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { listSimulationsQuerySchema } from "@/schemas/list-simulations-query-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListSimulationsBusinessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { id, role } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { page, limit, search, status } = request.query as z.infer<
      typeof listSimulationsQuerySchema
    >;

    const listSimulationsUseCase = container.resolve(
      ListSimulationsBusinessUseCase,
    );

    // Secure handling for URL decoding
    let decodedSearch: string | undefined = undefined;
    if (search) {
      try {
        decodedSearch = decodeURIComponent(search);
      } catch (error) {
        decodedSearch = search;
      }
    }

    try {
      const simulationsPromise = listSimulationsUseCase.execute(
        {
          businessId,
          page: page || 1,
          pageSize: limit || 10,
          search: decodedSearch,
          status,
          currentUserRole: role,
        },
        id,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: simulationsPromise,
        page: page || 1,
        pageSize: limit || 10,
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

export { ListSimulationsBusinessController };
