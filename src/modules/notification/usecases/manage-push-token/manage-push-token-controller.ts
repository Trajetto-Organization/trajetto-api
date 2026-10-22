import { FastifyReply, FastifyRequest } from "fastify";

import {
  RegisterPushTokenUseCase,
  RemovePushTokenUseCase,
} from "./manage-push-token-usecase";
import { container } from "tsyringe";
import { z } from "zod";

const pushTokenSchema = z.object({
  token: z.string().min(1, "Token é obrigatório.").max(4096, "Token inválido."),
  platform: z.enum(["android", "ios"], {
    errorMap: () => ({ message: "Plataforma inválida (android ou ios)." }),
  }),
});

const removePushTokenSchema = z.object({
  token: z.string().min(1, "Token é obrigatório.").max(4096, "Token inválido."),
});

class RegisterPushTokenController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id, sessionId } = request.user;
    const { token, platform } = pushTokenSchema.parse(request.body);

    const registerPushTokenUseCase = container.resolve(
      RegisterPushTokenUseCase,
    );

    await registerPushTokenUseCase.execute({
      userId: id,
      sessionId,
      token,
      platform,
    });
    return reply
      .status(200)
      .send({ message: "Dispositivo registrado para notificações." });
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
