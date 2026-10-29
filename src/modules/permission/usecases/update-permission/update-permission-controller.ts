import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { toHttpError } from "@/shared/errors/http-error-rules";
import { PERMISSION_BODY_LINK_RULES } from "@/modules/permission/usecases/errors/permission-http-errors";

import { UpdatePermissionUseCase } from "./update-permission-usecase";
import { updatePermissionSchema } from "@/schemas/update-permission-schema";

import { updateDeletePermissionSchema } from "@/schemas/update-delete-permission-schema";

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
    } catch (error) {
      throw toHttpError(error, PERMISSION_BODY_LINK_RULES);
    }

    return reply
      .status(200)
      .send({ message: "Permissão atualizada com sucesso!" });
  }
}

export { UpdatePermissionController };
