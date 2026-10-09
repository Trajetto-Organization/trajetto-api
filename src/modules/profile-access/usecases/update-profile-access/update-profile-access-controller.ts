import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateProfileAccessUseCase } from "./update-profile-access-usecase";

import { updateProfileAccessSchema } from "@/schemas/update-profile-access";
import { updateDeleteProfileAccessSchema } from "@/schemas/update-delete-profile-access-schema";


class UpdateProfileAccessController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { profileAccessId } = updateDeleteProfileAccessSchema.parse(
      request.params,
    );
    const { name } = updateProfileAccessSchema.parse(request.body);

    const updateProfileAccessUseCase = container.resolve(
      UpdateProfileAccessUseCase,
    );

    await updateProfileAccessUseCase.execute(
      {
        profileAccessId,
        name,
      },
      id,
    );

    return reply
      .status(200)
      .send({ message: "Perfil de acesso atualizado com sucesso!" });
  }
}

export { UpdateProfileAccessController };
