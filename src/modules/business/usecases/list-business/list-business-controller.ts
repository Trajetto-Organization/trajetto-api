import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListBusinessUseCase } from "./list-business-usecase";

import { listBusinessSchema } from "@/schemas/list-business-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListBusinessController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it would refuse it.
    const { page, pageSize, search, sort, order, status, uf } =
      request.query as z.infer<typeof listBusinessSchema>;

    const listBusinessUseCase = container.resolve(ListBusinessUseCase);

    // A term the client encoded twice still reads as typed.
    let decodedSearch: string | undefined = undefined;
    if (search) {
      try {
        decodedSearch = decodeURIComponent(search);
      } catch (error) {
        decodedSearch = search;
      }
    }

    await sendAsNDJSON({
      reply,
      page,
      pageSize,
      dataPromise: listBusinessUseCase
        .execute({
          userId: id,
          page,
          pageSize,
          search: decodedSearch,
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

export { ListBusinessController };
