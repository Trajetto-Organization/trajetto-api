import { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { container } from "tsyringe";
import { ListVehicleChecklistUseCase } from "./list-vehicle-checklist-usecase";
import { sendAsNDJSON } from "@/config/stream-utils";
import { listVehicleChecklistSchema } from "@/schemas/list-vehicle-checklist-schema";
import { replyChecklistError } from "../errors/vehicle-checklist-http-errors";

class ListVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Validated and transformed by the route (each facet is a list here).
    const {
      businessId,
      page,
      pageSize,
      search,
      sort,
      order,
      overall_condition,
      branchId,
      vehicleId,
    } = request.query as z.infer<typeof listVehicleChecklistSchema>;

    const listVehicleChecklistUseCase = container.resolve(
      ListVehicleChecklistUseCase,
    );

    try {
      const resultPromise = listVehicleChecklistUseCase
        .execute({
          userId: id,
          businessId,
          page,
          pageSize,
          search: search?.trim() || undefined,
          sort,
          order,
          conditions: overall_condition,
          branchIds: branchId,
          vehicleIds: vehicleId,
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
      if (replyChecklistError(reply, error)) return;

      throw error;
    }
  }
}

export { ListVehicleChecklistController };
