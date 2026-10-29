import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { toHttpError } from "@/shared/errors/http-error-rules";
import { PERMISSION_BODY_LINK_RULES } from "@/modules/permission/usecases/errors/permission-http-errors";

import { BulkConfigurePermissionsUseCase } from "./bulk-configure-permissions-usecase";
import { bulkConfigurePermissionsSchema } from "@/schemas/bulk-configure-permissions-schema";

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
    } catch (error) {
      throw toHttpError(error, PERMISSION_BODY_LINK_RULES);
    }

    return reply
      .status(200)
      .send({ message: "Permissões configuradas com sucesso!" });
  }
}

export { BulkConfigurePermissionsController };
