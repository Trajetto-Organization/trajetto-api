import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { WhatsAppStatusUseCase } from "./whatsapp-status-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { WhatsAppNotConnectedError } from "../errors/whatsapp-not-connected-error";

class WhatsAppStatusController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;

    try {
      const refreshStatusUseCase = container.resolve(WhatsAppStatusUseCase);
      const connectionInfo = await refreshStatusUseCase.execute(userId);

      return reply.status(200).send({
        success: true,
        message: "Status atualizado com sucesso",
        data: connectionInfo,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppNotConnectedError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { WhatsAppStatusController };
