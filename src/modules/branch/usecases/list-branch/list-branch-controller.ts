import { FastifyReply, FastifyRequest } from "fastify";

import { container } from "tsyringe";
import { z } from "zod";

import { ListBranchUseCase } from "./list-branch-usecase";

import { listBranchSchema } from "@/schemas/list-branch-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListBranchController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it would refuse it.
    const { businessId, page, pageSize, search, sort, order, status, uf } =
      request.query as z.infer<typeof listBranchSchema>;

    const listBranchUseCase = container.resolve(ListBranchUseCase);

    await sendAsNDJSON({
      reply,
      page,
      pageSize,
      dataPromise: listBranchUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search,
          statuses: status,
          ufs: uf,
          sort,
          order,
        })
        .then((result) => ({
          data: result.data,
          total: result.total,
          meta: result.searchMeta,
        })),
    });
  }
}

export { ListBranchController };
