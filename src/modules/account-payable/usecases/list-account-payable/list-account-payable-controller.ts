import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { container } from "tsyringe";

import { ListAccountPayableUseCase } from "./list-account-payable-usecase";

import { listAccountPayableSchema } from "@/schemas/list-account-payable-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListAccountPayableController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it would refuse it. No
    // decodeURIComponent either — Fastify decodes once, and a second pass
    // broke any search with a "%" in it.
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      status,
      category,
    } = request.query as z.infer<typeof listAccountPayableSchema>;

    const listAccountPayableUseCase = container.resolve(
      ListAccountPayableUseCase,
    );

    await sendAsNDJSON({
      reply,
      page,
      pageSize,
      dataPromise: listAccountPayableUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search,
          statusGroups: status,
          categories: category,
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

export { ListAccountPayableController };
