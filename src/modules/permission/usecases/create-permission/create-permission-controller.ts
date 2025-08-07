import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreatePermissionUseCase } from "./create-permission-usecase";
import { createPermissionSchema } from "@/schemas/create-permission-schema";

import { PermissionAlreadyAssignedError } from "../errors/permission-already-assigned-error";
import { PermissionAlreadyExistsError } from "../errors/permission-already-exists-error";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";
import { ProfileAccessNotFoundError } from "@/modules/user/usecases/errors/profile-access-not-found-error";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { PermissionBusinessError } from "../errors/permission-business-error";

class CreatePermissionController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const {
      businessId,
      profileAccessId,
      action,
      canRead,
      canWrite,
      permissionKey,
    } = createPermissionSchema.parse(request.body);
    const createPermissionUseCase = container.resolve(CreatePermissionUseCase);

    try {
      await createPermissionUseCase.execute(
        {
          action,
          businessId,
          canRead,
          canWrite,
          profileAccessId,
          permissionKey,
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Permissão criada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PermissionBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PermissionAlreadyAssignedError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PermissionAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ProfileAccessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreatePermissionController };
