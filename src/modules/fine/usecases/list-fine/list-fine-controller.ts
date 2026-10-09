import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { listFineSchema } from "@/schemas/list-fine-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

import { ListFineUseCase } from "./list-fine-usecase";

class ListFineController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing the transformed value against
    // the wire schema would reject it. Fastify also decoded the search term.
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      status,
      branchId,
      trafficViolationCodeId,
    } = request.query as z.infer<typeof listFineSchema>;

    const listFineUseCase = container.resolve(ListFineUseCase);

    const resultPromise = listFineUseCase
      .execute({
        userId: id,
        businessId,
        page,
        pageSize,
        search,
        sort,
        order,
        statuses: status,
        branchIds: branchId,
        trafficViolationCodeIds: trafficViolationCodeId,
      })
      .then((result) => ({
        data: result.data,
        total: result.total,
        meta: result.searchMeta,
      }));

    await sendAsNDJSON({
      reply,
      dataPromise: resultPromise,
      page,
      pageSize,
    });
  }
}

export { ListFineController };
