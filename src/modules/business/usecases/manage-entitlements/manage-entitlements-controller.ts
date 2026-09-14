import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";
import { BusinessModule } from "@prisma/client";

import {
  GetBusinessEntitlementsUseCase,
  GetModuleImpactUseCase,
  UpdateBusinessEntitlementUseCase,
} from "./manage-entitlements-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

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

    try {
      const result = await getBusinessEntitlementsUseCase.execute({
        userId: id,
        businessId,
      });

      return reply.status(200).send({ data: result });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

class GetModuleImpactController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { businessId, module } = moduleImpactParamsSchema.parse(
      request.params,
    );

    const getModuleImpactUseCase = container.resolve(GetModuleImpactUseCase);

    try {
      const result = await getModuleImpactUseCase.execute({
        userId: id,
        businessId,
        module,
      });

      return reply.status(200).send({ data: result });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
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

    try {
      await updateBusinessEntitlementUseCase.execute({
        userId: id,
        businessId,
        module,
        enabled,
      });

      return reply
        .status(200)
        .send({ message: "Módulo da empresa atualizado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export {
  GetBusinessEntitlementsController,
  UpdateBusinessEntitlementController,
  GetModuleImpactController,
};
