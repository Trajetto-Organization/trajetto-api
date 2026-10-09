import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeletePermissionUseCase } from "./delete-permission-usecase";

import { updateDeletePermissionSchema } from "@/schemas/update-delete-permission-schema";

class DeletePermissionController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { permissionId } = updateDeletePermissionSchema.parse(request.params);

    const deletePermissionUseCase = container.resolve(DeletePermissionUseCase);

    await deletePermissionUseCase.execute(permissionId, id);
    return reply
      .status(200)
      .send({ message: "Permissão deletada com sucesso!" });
  }
}

export { DeletePermissionController };
