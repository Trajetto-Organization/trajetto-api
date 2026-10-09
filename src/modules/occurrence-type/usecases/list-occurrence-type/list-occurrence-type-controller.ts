import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";
import { ListOccurrenceTypeUseCase } from "./list-occurrence-type-usecase";

import { listOccurrenceTypeSchema } from "@/schemas/list-occurrence-type-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListOccurrenceTypeController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    // Already validated AND transformed by the route: the filters arrive as
    // lists, the sort as one of the whitelisted keys.
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      status,
      blocking,
      photo,
      category,
    } = request.query as z.infer<typeof listOccurrenceTypeSchema>;

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

    // A missing caller is an AppError (404 USER_NOT_FOUND), answered by the
    // global handler before the stream opens (decision 11.3).
    const typesPromise = listOccurrenceTypeUseCase.execute({
      userId: id,
      businessId,
      page,
      pageSize,
      search: decodedSearch,
      sort,
      order,
      statuses: status,
      blocking,
      photo,
      categories: category,
    });

    await sendAsNDJSON({
      reply,
      dataPromise: typesPromise,
      page,
      pageSize,
    });
  }
}

export { ListOccurrenceTypeController };
