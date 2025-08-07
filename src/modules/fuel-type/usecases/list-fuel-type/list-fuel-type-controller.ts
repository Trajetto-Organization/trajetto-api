import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListFuelTypeUseCase } from "./list-fuel-type-usecase";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListFuelTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { page, pageSize, search } = request.query as z.infer<
      typeof listPagesSchema
    >;

    const listFuelTypeUseCase = container.resolve(ListFuelTypeUseCase);

    // Secure handling for URL decoding
    let decodedSearch: string | undefined = undefined;
    if (search) {
      try {
        // Try to decode, but catch errors
        decodedSearch = decodeURIComponent(search);
      } catch (error) {
        // If it fails, use the value without decoding.
        decodedSearch = search;
      }
    }

    try {
      const fuelTypesPromise = listFuelTypeUseCase.execute(
        id,
        page,
        pageSize,
        decodedSearch,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: fuelTypesPromise,
        page,
        pageSize,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListFuelTypeController };
