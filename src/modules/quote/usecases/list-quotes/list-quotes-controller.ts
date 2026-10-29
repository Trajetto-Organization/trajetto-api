import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { ListQuotesUseCase } from "./list-quotes-usecase";
import { listQuotesQuerySchema } from "@/schemas/list-quotes-query-schema";
import { sendAsNDJSON } from "@/config/stream-utils";
import { z } from "zod";

class ListQuotesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it would refuse it.
    const { page, pageSize, search, sort, order, status, fleet_size } =
      request.query as z.infer<typeof listQuotesQuerySchema>;

    const listQuotesUseCase = container.resolve(ListQuotesUseCase);

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
      dataPromise: listQuotesUseCase
        .execute({
          userId: id,
          page,
          pageSize,
          search: decodedSearch,
          statuses: status,
          fleetSizes: fleet_size,
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

export { ListQuotesController };
