import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { enrollSessionSchema } from "@/schemas/driver-access-schema";

import { EnrollDriverSessionUseCase } from "./enroll-driver-session-usecase";

class EnrollDriverSessionController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { qrToken, accessCode, deviceId } = enrollSessionSchema.parse(
      request.body,
    );

    const { token, refresh_token, role, mustChangePassword } = await container
      .resolve(EnrollDriverSessionUseCase)
      .execute({ qrToken, accessCode, deviceId });

    reply.header("cache-control", "no-store");

    return reply.status(200).send({
      message: "Usuário autenticado com sucesso!",
      token,
      refresh_token,
      role,
      // Additive (wave 2): older builds ignore it.
      mustChangePassword,
    });
  }
}

export { EnrollDriverSessionController };
