import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListOccurrencesUseCase } from "./list-occurrences-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { listOccurrencesSchema } from "@/schemas/list-occurrences-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListOccurrencesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is
    // a number, blocksDelivery a boolean) — re-parsing the transformed
    // value against the wire schema would reject it. Same reading the
    // delivery list does.
    const {
      businessId,
      page,
      pageSize,
      search,
      blocksDelivery,
      occurrenceTypeId,
    } = request.query as z.infer<typeof listOccurrencesSchema>;

    const listOccurrencesUseCase = container.resolve(ListOccurrencesUseCase);

    try {
      // NDJSON, like every list feeding the deliveries page: the shared
      // parser reads one dialect and the tab plugs in with no special case.
      const resultPromise = listOccurrencesUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search,
          blocksDelivery,
          occurrenceTypeId,
        })
        .then((result) => ({
          data: result.data,
          total: result.total,
          meta: result.counts,
        }));

      await sendAsNDJSON({
        reply,
        dataPromise: resultPromise,
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

export { ListOccurrencesController };
