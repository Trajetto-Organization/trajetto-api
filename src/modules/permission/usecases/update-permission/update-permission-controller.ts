import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdatePermissionUseCase } from "./update-permission-usecase";
import { updatePermissionSchema } from "@/schemas/update-permission-schema";

import { updateDeletePermissionSchema } from "@/schemas/update-delete-permission-schema";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { PermissionNotFoundError } from "../errors/permission-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ProfileAccessNotFoundError } from "@/modules/profile-access/usecases/errors/profile-access-not-found-error";
import { PermissionCannotBeUpdatedByHimselfError } from "../errors/permission-cannot-be-updated-by-himself-error";

import { PermissionAlreadyExistsError } from "../errors/permission-already-exists-error";
import { PermissionBusinessError } from "../errors/permission-business-error";

class UpdatePermissionController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const updatePermissionData = updatePermissionSchema.parse(request.body);

    const { permissionId } = updateDeletePermissionSchema.parse(request.params);
    const updatePermissionUseCase = container.resolve(UpdatePermissionUseCase);

    try {
      await updatePermissionUseCase.execute(
        {
          ...updatePermissionData,
          permissionId,
        },
        id,
      );

      return reply
        .status(200)
        .send({ message: "Permissão atualizada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PermissionCannotBeUpdatedByHimselfError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof PermissionBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof PermissionAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PermissionNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ProfileAccessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdatePermissionController };
