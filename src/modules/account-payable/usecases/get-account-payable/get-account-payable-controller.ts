import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { GetAccountPayableUseCase } from "./get-account-payable-usecase";

import { updateDeleteAccountPayableSchema } from "@/schemas/update-delete-account-payable-schema";
import { selectedCompanyQuerySchema } from "@/schemas/selected-company-query-schema";

class GetAccountPayableController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { accountPayableId } = updateDeleteAccountPayableSchema.parse(
      request.params,
    );
    // Validated by the route.
    const { businessId } = request.query as z.infer<
      typeof selectedCompanyQuerySchema
    >;

    const getAccountPayableUseCase = container.resolve(
      GetAccountPayableUseCase,
    );

    const accountPayable = await getAccountPayableUseCase.execute({
      userId: id,
      accountPayableId,
      businessId,
    });

    return reply.status(200).send({ accountPayable });
  }
}

export { GetAccountPayableController };
