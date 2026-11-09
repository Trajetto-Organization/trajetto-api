import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { GetServiceOrderUseCase } from "./get-service-order-usecase";

import { updateDeleteServiceOrderSchema } from "@/schemas/update-delete-service-order-schema";
import { selectedCompanyQuerySchema } from "@/schemas/selected-company-query-schema";

class GetServiceOrderController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { serviceOrderId } = updateDeleteServiceOrderSchema.parse(
      request.params,
    );
    // Validated by the route.
    const { businessId } = request.query as z.infer<
      typeof selectedCompanyQuerySchema
    >;

    const getServiceOrderUseCase = container.resolve(GetServiceOrderUseCase);

    const read = await getServiceOrderUseCase.execute({
      userId: id,
      serviceOrderId,
      businessId,
    });

    return reply.status(200).send(read);
  }
}

export { GetServiceOrderController };
