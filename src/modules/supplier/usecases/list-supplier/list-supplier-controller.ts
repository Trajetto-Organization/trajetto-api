import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { container } from "tsyringe";
import { ListSupplierUseCase } from "./list-supplier-usecase";
import { sendAsNDJSON } from "@/config/stream-utils";
import { listSupplierSchema } from "@/schemas/list-supplier-schema";

class ListSupplierController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, the UF facet a list): re-parsing it would refuse it.
    const { businessId, page, pageSize, search, sort, order, uf } =
      request.query as z.infer<typeof listSupplierSchema>;

    const listSupplierUseCase = container.resolve(ListSupplierUseCase);

    await sendAsNDJSON({
      reply,
      page,
      pageSize,
      dataPromise: listSupplierUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search,
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

export { ListSupplierController };
