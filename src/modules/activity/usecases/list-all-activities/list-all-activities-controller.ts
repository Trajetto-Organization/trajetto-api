import { FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import { container } from "tsyringe";

import { ListAllActivitiesUseCase } from "./list-all-activities-usecase";

import { listActivitiesSchema } from "@/schemas/list-activities-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

class ListAllActivitiesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id, role } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list): re-parsing it would refuse it.
    const {
      page,
      pageSize,
      search,
      businessId,
      order,
      status,
      type,
      action,
      role: roles,
    } = request.query as z.infer<typeof listActivitiesSchema>;

    const listAllActivitiesUseCase = container.resolve(
      ListAllActivitiesUseCase,
    );

    return await sendAsNDJSON({
      reply,
      dataPromise: listAllActivitiesUseCase.execute({
        userId: id,
        userRole: role,
        businessId,
        page,
        pageSize,
        search,
        statuses: status,
        types: type,
        actions: action,
        roles,
        order,
      }),
      page,
      pageSize,
    });
  }
}

export { ListAllActivitiesController };
