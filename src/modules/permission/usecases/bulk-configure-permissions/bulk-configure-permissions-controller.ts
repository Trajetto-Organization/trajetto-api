import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { BulkConfigurePermissionsUseCase } from "./bulk-configure-permissions-usecase";
import { bulkConfigurePermissionsSchema } from "@/schemas/bulk-configure-permissions-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { UserProfileAccessNotFoundError } from "@/modules/user/usecases/errors/user-profile-access-not-found-error";
import { PermissionBusinessError } from "../errors/permission-business-error";

class BulkConfigurePermissionsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId, profileAccessId, permissions } =
      bulkConfigurePermissionsSchema.parse(request.body);

    const bulkConfigurePermissionsUseCase = container.resolve(
      BulkConfigurePermissionsUseCase,
    );

    try {
      await bulkConfigurePermissionsUseCase.execute(
        { businessId, profileAccessId, permissions },
        id,
      );

      return reply
        .status(200)
        .send({ message: "Permissões configuradas com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserProfileAccessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PermissionBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { BulkConfigurePermissionsController };
