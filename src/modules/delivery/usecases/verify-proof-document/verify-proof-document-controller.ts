import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { VerifyProofDocumentUseCase } from "./verify-proof-document-usecase";
import { verifyProofParamsSchema } from "@/schemas/proof-document-schema";

/**
 * The page a QR scan lands on. No token, no session, no tenant.
 *
 * The verification code IS the authorisation, which is why the route carries
 * its own rate limit and why the response is deliberately narrow.
 */
class VerifyProofDocumentController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { token } = verifyProofParamsSchema.parse(request.params);

    const useCase = container.resolve(VerifyProofDocumentUseCase);

    const result = await useCase.execute({ token });

    // No caching: whether the file still matches its hash is the one thing on
    // this page that must never be answered from yesterday.
    return reply
      .header("Cache-Control", "no-store")
      .status(200)
      .send({
        message: result.intact
          ? "Comprovante íntegro."
          : "Não foi possível confirmar a integridade deste comprovante.",
        data: result,
      });
  }
}

export { VerifyProofDocumentController };
