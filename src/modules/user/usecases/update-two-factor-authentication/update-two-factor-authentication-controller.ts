import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { updateTwoFactorSchema } from "@/schemas/update-two-factor-schema";

import { UpdateTwoFactorAuthenticationUseCase } from "./update-two-factor-authentication-usecase";

class UpdateTwoFactorAuthenticationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    // Parsed by hand: the route declares no body, because a request with
    // none is still the old toggle for one release (wave 2).
    const legacy = request.body === undefined || request.body === null;
    const change = legacy
      ? undefined
      : updateTwoFactorSchema.parse(request.body);

    if (legacy) {
      // The trace that says when the web image of the release before is gone
      // and the toggle can be removed (docs/deploy.md).
      request.log.warn(
        { event: "auth.twofactor_legacy_toggle", userId: id },
        "Deprecated contract: two-factor toggled without a body",
      );
    }

    const updateTwoFactorAuthenticationUseCase = container.resolve(
      UpdateTwoFactorAuthenticationUseCase,
    );

    const { enabled } = await updateTwoFactorAuthenticationUseCase.execute({
      userId: id,
      change,
    });

    return reply.status(200).send({
      message: "Autenticação de dois fatores atualizada com sucesso!",
      // Additive (wave 2): the state the account is in now.
      twoFactorEnabled: enabled,
    });
  }
}

export { UpdateTwoFactorAuthenticationController };
