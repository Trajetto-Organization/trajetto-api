import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { toHttpError } from "@/shared/errors/http-error-rules";
import { USER_BODY_LINK_RULES } from "@/modules/user/usecases/errors/user-http-errors";

import { CreateUserUseCase } from "./create-user-usecase";

import { createUserSchema } from "@/schemas/create-user-schema";

class CreateUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const userData = createUserSchema.parse(request.body);
    const createUserUseCase = container.resolve(CreateUserUseCase);

    try {
      await createUserUseCase.execute(userData, id);
    } catch (error) {
      throw toHttpError(error, USER_BODY_LINK_RULES);
    }
    return reply.status(201).send({ message: "Usuário criado com sucesso!" });
  }
}

export { CreateUserController };
