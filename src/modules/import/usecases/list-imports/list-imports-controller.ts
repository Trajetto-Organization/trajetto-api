import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListImportsUseCase } from "./list-imports-usecase";
import { listImportsSchema } from "@/schemas/import-spreadsheet-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListImportsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Already validated AND transformed by the route: the filters arrive as
    // lists, the sort as one of the whitelisted keys.
    const {
      businessId,
      page,
      pageSize,
      includeReport,
      sort,
      order,
      status,
      source,
    } = request.query as z.infer<typeof listImportsSchema>;

    const useCase = container.resolve(ListImportsUseCase);

    // A missing caller is an AppError (404 USER_NOT_FOUND), answered by the
    // global handler before the stream opens (decision 11.3).
    const importsPromise = useCase.execute({
      userId: id,
      businessId,
      page,
      pageSize,
      includeReport,
      sort,
      order,
      statuses: status,
      sources: source,
    });

    await sendAsNDJSON({
      reply,
      dataPromise: importsPromise,
      page,
      pageSize,
    });
  }
}

export { ListImportsController };
