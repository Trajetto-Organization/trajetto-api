import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";
import { ListOccurrenceTypeUseCase } from "./list-occurrence-type-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { listOccurrenceTypeSchema } from "@/schemas/list-occurrence-type-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListOccurrenceTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId, page, pageSize, search } = request.query as z.infer<
      typeof listOccurrenceTypeSchema
    >;

    const listOccurrenceTypeUseCase = container.resolve(
      ListOccurrenceTypeUseCase,
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
      const typesPromise = listOccurrenceTypeUseCase.execute({
        userId: id,
        businessId,
        page,
        pageSize,
        search: decodedSearch,
      });

      await sendAsNDJSON({
        reply,
        dataPromise: typesPromise,
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

export { ListOccurrenceTypeController };
