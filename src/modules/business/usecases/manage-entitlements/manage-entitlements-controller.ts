import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";
import { BusinessModule } from "@prisma/client";

import {
  GetBusinessEntitlementsUseCase,
  GetModuleImpactUseCase,
  UpdateBusinessEntitlementUseCase,
} from "./manage-entitlements-usecase";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

const moduleImpactParamsSchema = z.object({
  businessId: z.string().min(1, "O identificador da empresa é obrigatório."),
  module: z.nativeEnum(BusinessModule, {
    errorMap: () => ({ message: "Módulo inválido." }),
  }),
});

const updateEntitlementSchema = z.object({
  module: z.nativeEnum(BusinessModule, {
    errorMap: () => ({ message: "Módulo inválido." }),
  }),
  enabled: z.boolean(),
});

class GetBusinessEntitlementsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const getBusinessEntitlementsUseCase = container.resolve(
      GetBusinessEntitlementsUseCase,
    );

    const result = await getBusinessEntitlementsUseCase.execute({
      userId: id,
      businessId,
    });

    return reply.status(200).send({ data: result });
  }
}

class GetModuleImpactController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, module } = moduleImpactParamsSchema.parse(
      request.params,
    );

    const getModuleImpactUseCase = container.resolve(GetModuleImpactUseCase);

    const result = await getModuleImpactUseCase.execute({
      userId: id,
      businessId,
      module,
    });

    return reply.status(200).send({ data: result });
  }
}

class UpdateBusinessEntitlementController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const { module, enabled } = updateEntitlementSchema.parse(request.body);

    const updateBusinessEntitlementUseCase = container.resolve(
      UpdateBusinessEntitlementUseCase,
    );

    await updateBusinessEntitlementUseCase.execute({
      userId: id,
      businessId,
      module,
      enabled,
    });

    return reply
      .status(200)
      .send({ message: "Módulo da empresa atualizado com sucesso!" });
  }
}

export {
  GetBusinessEntitlementsController,
  UpdateBusinessEntitlementController,
  GetModuleImpactController,
};
