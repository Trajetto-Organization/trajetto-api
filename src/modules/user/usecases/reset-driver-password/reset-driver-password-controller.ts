import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { driverLoginParamsSchema } from "@/schemas/driver-access-schema";
import { resetDriverPasswordSchema } from "@/schemas/reset-driver-password-schema";

import { ResetDriverPasswordUseCase } from "./reset-driver-password-usecase";

class ResetDriverPasswordController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { userId } = driverLoginParamsSchema.parse(request.params);
    const { password } = resetDriverPasswordSchema.parse(request.body);

    await container.resolve(ResetDriverPasswordUseCase).execute({
      actorId: request.user.id,
      userId,
      password,
    });

    return reply.status(200).send({
      message: "Senha do motorista redefinida com sucesso!",
    });
  }
}

export { ResetDriverPasswordController };
