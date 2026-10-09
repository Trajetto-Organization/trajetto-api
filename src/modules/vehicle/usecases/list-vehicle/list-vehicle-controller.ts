import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { container } from "tsyringe";
import { ListVehicleUseCase } from "./list-vehicle-usecase";
import { sendAsNDJSON } from "@/config/stream-utils";
import { listVehicleSchema } from "@/schemas/list-vehicle-schema";
import { replyVehicleError } from "../errors/vehicle-http-errors";

class ListVehicleController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (page is a
    // number, each facet a list); re-parsing the transformed value against
    // the wire schema would reject it.
    const { businessId, page, pageSize, search, sort, order, status, branchId } =
      request.query as z.infer<typeof listVehicleSchema>;

    const listVehicleUseCase = container.resolve(ListVehicleUseCase);

    try {
      const resultPromise = listVehicleUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search: search?.trim() || undefined,
          sort,
          order,
          statuses: status,
          branchIds: branchId,
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
    } catch (error) {
      if (replyVehicleError(reply, error)) return;

      throw error;
    }
  }
}

export { ListVehicleController };
