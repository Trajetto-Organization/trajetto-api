import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteProfileAccessUseCase } from "./delete-profile-access-usecase";

import { updateDeleteProfileAccessSchema } from "@/schemas/update-delete-profile-access-schema";

import { ProfileAccessInUseError } from "../errors/profile-access-in-use-error";

class DeleteProfileAccessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { profileAccessId } = updateDeleteProfileAccessSchema.parse(
      request.params,
    );

    const deleteProfileAccessUseCase = container.resolve(
      DeleteProfileAccessUseCase,
    );

    try {
      await deleteProfileAccessUseCase.execute(profileAccessId, id);
      return reply
        .status(200)
        .send({ message: "Perfil de acesso deletado com sucesso!" });
    } catch (error) {
      // The only inline answer: the web says how many people hold the
      // profile, and the global handler sends message and code only.
      if (error instanceof ProfileAccessInUseError) {
        return reply
          .header("x-error-code", error.code)
          .status(409)
          .send({
            code: error.code,
            message: error.message,
            usersCount: error.usersCount,
          });
      }

      throw error;
    }
  }
}

export { DeleteProfileAccessController };
