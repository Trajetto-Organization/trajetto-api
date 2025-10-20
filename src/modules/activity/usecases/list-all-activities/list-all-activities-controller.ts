import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListAllActivitiesUseCase } from "./list-all-activities-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListAllActivitiesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id, role } = request.user;

    const { page, pageSize, search } = request.query as z.infer<
      typeof listPagesSchema
    >;

    const listAllActivitiesUseCase = container.resolve(
      ListAllActivitiesUseCase,
    );

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
      const listActivities = listAllActivitiesUseCase.execute({
        userId: id,
        userRole: role,
        page,
        pageSize,
        search: decodedSearch,
      });

      await sendAsNDJSON({
        reply,
        dataPromise: listActivities,
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

export { ListAllActivitiesController };
