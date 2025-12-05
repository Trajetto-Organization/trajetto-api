import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ListAccountPayableByResponsibleUserUseCase } from "./list-account-payable-by-responsible-user-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListAccountPayableByResponsibleUserController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { page, pageSize } = request.query as z.infer<typeof listPagesSchema>;

    const listAccountPayableByResponsibleUserUseCase = container.resolve(
      ListAccountPayableByResponsibleUserUseCase,
    );

    try {
      const accountPayablesPromise =
        listAccountPayableByResponsibleUserUseCase.execute(id, page, pageSize);

      await sendAsNDJSON({
        reply,
        dataPromise: accountPayablesPromise,
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

export { ListAccountPayableByResponsibleUserController };
