import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { proofLinkParamsSchema } from "@/schemas/integration-schema";

import { OpenProofLinkUseCase } from "./open-proof-link-usecase";

/**
 * The integrator's `proof_url` (L7): no session, no key — the signed link is
 * the authorisation, which is why the route carries its own rate limit.
 */
class OpenProofLinkController {
  handle = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const { token } = proofLinkParamsSchema.parse(request.params);

    const url = await container.resolve(OpenProofLinkUseCase).execute(token);

    // Never cached (the file URL behind it is short-lived) and never leaked
    // onward as a referrer: the link itself is the capability.
    return reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .redirect(url, 302);
  };
}

export { OpenProofLinkController };
