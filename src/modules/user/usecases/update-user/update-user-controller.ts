import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { toHttpError } from "@/shared/errors/http-error-rules";
import { USER_UPDATE_LINK_RULES } from "@/modules/user/usecases/errors/user-http-errors";

import { UpdateUserUseCase } from "./update-user-usecase";

import { updateUserSchema } from "@/schemas/update-user-schema";

import { updateDeleteUserSchema } from "@/schemas/update-delete-user-schema";

class UpdateUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { userId } = updateDeleteUserSchema.parse(request.params);

    const userData = updateUserSchema.parse(request.body);
    const updateUserUseCase = container.resolve(UpdateUserUseCase);

    try {
      await updateUserUseCase.execute(
        {
          userId,
          userData,
        },
        id,
      );
    } catch (error) {
      throw toHttpError(error, USER_UPDATE_LINK_RULES);
    }

    return reply
      .status(200)
      .send({ message: "Usuário atualizado com sucesso!" });
  }
}

export { UpdateUserController };
