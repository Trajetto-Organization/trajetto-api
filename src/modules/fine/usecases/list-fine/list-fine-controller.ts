import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { z } from "zod";

import { ListFineUseCase } from "./list-fine-usecase";
import { sendAsNDJSON } from "@/config/stream-utils";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class ListFineController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { page, pageSize, search } = request.query as z.infer<
      typeof listPagesSchema
    >;

    const listFineUseCase = container.resolve(ListFineUseCase);

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
      const finesPromise = listFineUseCase.execute(
        id,
        page,
        pageSize,
        decodedSearch,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: finesPromise,
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

export { ListFineController };
