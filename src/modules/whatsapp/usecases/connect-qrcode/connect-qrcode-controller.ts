import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { ConnectQRCodeUseCase } from "./connect-qrcode-usecase";
import { WhatsAppNotConnectedError } from "../errors/whatsapp-not-connected-error";

import { WhatsAppNumberNotConfiguredError } from "../errors/whatsapp-number-not-configured-error";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { WhatsAppAlreadyConnectedError } from "../errors/whatsapp-already-connected-error";
import { WhatsAppPhoneAlreadyInUseError } from "../errors/whatsapp-phone-already-in-use-error";

import { WhatsAppBusinessInstanceNotFoundError } from "../errors/whatsapp-business-instance-not-found-error";
import { WhatsAppBusinessNotConnected } from "../errors/whatsapp-business-not-connected-error";

class ConnectQRCodeController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;

    try {
      const connectQRCodeUseCase = container.resolve(ConnectQRCodeUseCase);
      const qrCodeData = await connectQRCodeUseCase.execute(userId);

      return reply.status(200).send({
        success: true,
        message: "QR Code gerado com sucesso",
        data: qrCodeData,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppBusinessInstanceNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof WhatsAppNotConnectedError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppNumberNotConfiguredError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppAlreadyConnectedError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppPhoneAlreadyInUseError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppBusinessNotConnected) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ConnectQRCodeController };
