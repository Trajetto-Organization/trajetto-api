import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";
import { ListStatusChangeReasonUseCase } from "./list-status-change-reason-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { listStatusChangeReasonSchema } from "@/schemas/list-status-change-reason-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListStatusChangeReasonController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, page, pageSize, search } = request.query as z.infer<
      typeof listStatusChangeReasonSchema
    >;

    const listStatusChangeReasonUseCase = container.resolve(
      ListStatusChangeReasonUseCase,
    );

    // A term typed with an accent arrives percent-encoded, and a malformed
    // sequence must not 500.
    let decodedSearch: string | undefined;

    if (search) {
      try {
        decodedSearch = decodeURIComponent(search);
      } catch {
        decodedSearch = search;
      }
    }

    try {
      const reasonsPromise = listStatusChangeReasonUseCase.execute({
        userId: id,
        businessId,
        page,
        pageSize,
        search: decodedSearch,
      });

      await sendAsNDJSON({
        reply,
        dataPromise: reasonsPromise,
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

export { ListStatusChangeReasonController };
