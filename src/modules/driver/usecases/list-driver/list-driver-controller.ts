import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ListDriverUseCase } from "./list-driver-usecase";

import { listDriverSchema } from "@/schemas/list-driver-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListDriverController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it against the wire schema would
    // reject its own output.
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      status,
      contract_type,
      cnh_category,
      branchId,
    } = request.query as z.infer<typeof listDriverSchema>;

    const listDriverUseCase = container.resolve(ListDriverUseCase);

    await sendAsNDJSON({
      reply,
      page,
      pageSize,
      dataPromise: listDriverUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search: search?.trim() || undefined,
          sort,
          order,
          statuses: status,
          contractTypes: contract_type,
          cnhCategories: cnh_category,
          branchIds: branchId,
        })
        .then((result) => ({
          data: result.data,
          total: result.total,
          meta: result.searchMeta,
        })),
    });
  }
}

export { ListDriverController };
