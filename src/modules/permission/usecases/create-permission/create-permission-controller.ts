import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { toHttpError } from "@/shared/errors/http-error-rules";
import { PERMISSION_BODY_LINK_RULES } from "@/modules/permission/usecases/errors/permission-http-errors";

import { CreatePermissionUseCase } from "./create-permission-usecase";
import { createPermissionSchema } from "@/schemas/create-permission-schema";

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
    } catch (error) {
      throw toHttpError(error, PERMISSION_BODY_LINK_RULES);
    }

    return reply
      .status(201)
      .send({ message: "Permissão criada com sucesso!" });
  }
}

export { CreatePermissionController };
