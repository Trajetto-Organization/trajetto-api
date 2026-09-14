import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import {
  RegisterPushTokenUseCase,
  RemovePushTokenUseCase,
} from "./manage-push-token-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

const pushTokenSchema = z.object({
  token: z
    .string()
    .min(1, "Token é obrigatório.")
    .max(4096, "Token inválido."),
  platform: z.enum(["android", "ios"], {
    errorMap: () => ({ message: "Plataforma inválida (android ou ios)." }),
  }),
});

const removePushTokenSchema = z.object({
  token: z.string().min(1, "Token é obrigatório.").max(4096, "Token inválido."),
});

class RegisterPushTokenController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { token, platform } = pushTokenSchema.parse(request.body);

    const registerPushTokenUseCase = container.resolve(RegisterPushTokenUseCase);

    try {
      await registerPushTokenUseCase.execute({ userId: id, token, platform });
      return reply
        .status(200)
        .send({ message: "Dispositivo registrado para notificações." });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

class RemovePushTokenController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { token } = removePushTokenSchema.parse(request.body);

    const removePushTokenUseCase = container.resolve(RemovePushTokenUseCase);

    await removePushTokenUseCase.execute({ userId: id, token });
    return reply.status(200).send({ message: "Dispositivo removido." });
  }
}

export { RegisterPushTokenController, RemovePushTokenController };
