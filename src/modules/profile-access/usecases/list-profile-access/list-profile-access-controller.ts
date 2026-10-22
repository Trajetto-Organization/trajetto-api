import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";
import { ListProfileAccessUseCase } from "./list-profile-access-usecase";
import { sendAsNDJSON } from "@/config/stream-utils";
import { listProfileAccessSchema } from "@/schemas/list-profile-access-schema";

class ListProfileAccessController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Validated and transformed by the route.
    const { businessId, page, pageSize, search, sort, order } =
      request.query as z.infer<typeof listProfileAccessSchema>;

    const listProfileAccessUseCase = container.resolve(
      ListProfileAccessUseCase,
    );

    await sendAsNDJSON({
      reply,
      page,
      pageSize,
      dataPromise: listProfileAccessUseCase.execute({
        userId: id,
        businessId,
        page,
        pageSize,
        search: search?.trim() || undefined,
        sort,
        order,
      }),
    });
  }
}

export { ListProfileAccessController };
