import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";
import { ListStatusChangeReasonUseCase } from "./list-status-change-reason-usecase";

import { listStatusChangeReasonSchema } from "@/schemas/list-status-change-reason-schema";

import { sendAsNDJSON } from "@/config/stream-utils";

class ListStatusChangeReasonController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Already validated AND transformed by the route: the Status filter
    // arrives as a list, the sort as one of the whitelisted keys.
    const { businessId, page, pageSize, search, sort, order, status } =
      request.query as z.infer<typeof listStatusChangeReasonSchema>;

    const listStatusChangeReasonUseCase = container.resolve(
      ListStatusChangeReasonUseCase,
    );

    // A term typed with an accent arrives percent-encoded, and a malformed
    // sequence must not 500.
    let decodedSearch: string | undefined;

    if (search) {
      try {
        decodedSearch = decodeURIComponent(search);
      } catch {
        decodedSearch = search;
      }
    }

    // A missing caller is an AppError (404 USER_NOT_FOUND), answered by the
    // global handler before the stream opens (decision 11.3).
    const reasonsPromise = listStatusChangeReasonUseCase.execute({
      userId: id,
      businessId,
      page,
      pageSize,
      search: decodedSearch,
      sort,
      order,
      statuses: status,
    });

    await sendAsNDJSON({
      reply,
      dataPromise: reasonsPromise,
      page,
      pageSize,
    });
  }
}

export { ListStatusChangeReasonController };
