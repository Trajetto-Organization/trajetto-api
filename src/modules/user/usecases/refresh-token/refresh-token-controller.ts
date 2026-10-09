import { FastifyReply, FastifyRequest } from "fastify";
import { JsonWebTokenError } from "jsonwebtoken";
import { container } from "tsyringe";

import { refreshTokenSchema } from "@/schemas/refresh-token-schema";
import { RefreshTokenUseCase } from "./refresh-token-usecase";

class RefreshTokenController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { token } = refreshTokenSchema.parse(request.body);
    const refreshTokenUseCase = container.resolve(RefreshTokenUseCase);

    try {
      const { refresh_token, token: newToken } =
        await refreshTokenUseCase.execute(token);

      return reply.status(200).send({ refresh_token, token: newToken });
    } catch (error) {
      if (error instanceof JsonWebTokenError) {
        return reply.status(401).send({
          code: "AUTH_REFRESH_INVALID",
          message: "Token de atualização inválido ou expirado.",
        });
      }

      throw error;
    }
  }
}

export { RefreshTokenController };
