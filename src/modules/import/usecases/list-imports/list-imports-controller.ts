import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListImportsUseCase } from "./list-imports-usecase";
import { listImportsSchema } from "@/schemas/import-spreadsheet-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListImportsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, page, pageSize } = request.query as z.infer<
      typeof listImportsSchema
    >;

    const useCase = container.resolve(ListImportsUseCase);

    try {
      const importsPromise = useCase.execute({
        userId: id,
        businessId,
        page,
        pageSize,
      });

      await sendAsNDJSON({
        reply,
        dataPromise: importsPromise,
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

export { ListImportsController };
