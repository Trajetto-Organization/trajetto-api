import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { ListOccurrencesUseCase } from "./list-occurrences-usecase";

import { listOccurrencesSchema } from "@/schemas/list-occurrences-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListOccurrencesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is
    // a number, each facet a list) — re-parsing the transformed value
    // against the wire schema would reject it.
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      severity,
      category,
      occurrenceTypeId,
      deliveryStatus,
    } = request.query as z.infer<typeof listOccurrencesSchema>;

    const listOccurrencesUseCase = container.resolve(ListOccurrencesUseCase);

    // NDJSON, like every list feeding the deliveries page: the shared
    // parser reads one dialect and the tab plugs in with no special case.
    const resultPromise = listOccurrencesUseCase
      .execute({
        userId: id,
        businessId,
        page,
        pageSize,
        search,
        sort,
        order,
        severity,
        category,
        occurrenceTypeIds: occurrenceTypeId,
        deliveryStatuses: deliveryStatus,
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

export { ListOccurrencesController };
