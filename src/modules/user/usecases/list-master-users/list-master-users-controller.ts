import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListMasterUsersUseCase } from "./list-master-users-usecase";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListMasterUsersController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { page, pageSize, search } = request.query as z.infer<
      typeof listPagesSchema
    >;

    const listMasterUsersUseCase = container.resolve(ListMasterUsersUseCase);

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
      const listMasterUsers = listMasterUsersUseCase.execute(
        page,
        pageSize,
        decodedSearch,
        id,
      );

      await sendAsNDJSON({
        reply,
        dataPromise: listMasterUsers,
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

export { ListMasterUsersController };
