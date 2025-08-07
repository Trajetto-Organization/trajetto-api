import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeletePermissionUseCase } from "./delete-permission-usecase";

import { updateDeletePermissionSchema } from "@/schemas/update-delete-permission-schema";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { PermissionNotFoundError } from "../errors/permission-not-found-error";
import { PermissionCannotBeDeletedByHimselfError } from "../errors/permission-cannot-be-deleted-by-himself-error";

class DeletePermissionController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { permissionId } = updateDeletePermissionSchema.parse(request.params);

    const deletePermissionUseCase = container.resolve(DeletePermissionUseCase);

    try {
      await deletePermissionUseCase.execute(permissionId, id);
      return reply
        .status(200)
        .send({ message: "Permissão deletada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof PermissionCannotBeDeletedByHimselfError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof PermissionNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeletePermissionController };
