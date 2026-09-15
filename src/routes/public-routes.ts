import { FastifyInstance } from "fastify";

import { VerifyProofDocumentController } from "@/modules/delivery/usecases/verify-proof-document/verify-proof-document-controller";

import {
  proofDocumentSchemas,
  proofDocumentResponses,
} from "./documentation/proof-document-documentation";

const verifyProofDocumentController = new VerifyProofDocumentController();

/**
 * What the product answers to somebody with no account.
 *
 * Everything here is reached by a token printed on a document or sent in a
 * message, and the token IS the authorisation — there is no session to check
 * and no tenant to scope by. Three rules follow from that and none of them is
 * optional:
 *
 *  - every route carries its own rate limit, because the only thing stopping
 *    somebody enumerating tokens is how many they can try;
 *  - every refusal is the same 404, so a probe cannot tell "wrong token" from
 *    "token for another company";
 *  - the responses are narrow. A leaked link must show that one receipt is
 *    genuine, not become a window on a carrier's operation.
 */
async function publicRoutes(app: FastifyInstance) {
  app.get(
    "/verify-proof/:token",
    {
      config: {
        rateLimit: {
          // Generous for a person who scanned a QR and reloaded twice;
          // useless to anybody walking the 2^256 space.
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        tags: ["public"],
        summary: "Verify a delivery receipt by its printed code",
        description:
          "Página pública do QR do comprovante. Não exige login: o código de verificação é a autorização. Responde se os bytes que estão no armazenamento AGORA ainda batem com o hash gravado quando o documento foi gerado — que é a razão de alguém escanear o código. `intact: false` com `storedSha256: null` significa arquivo ausente, não adulterado; os dois casos são diferentes e a página os distingue. O resumo é estreito de propósito: um link vazado mostra que UM comprovante é legítimo, não vira uma janela para a operação da transportadora.",
        params: proofDocumentSchemas.verifyProofParams,
        response: {
          200: proofDocumentResponses.proofVerification,
          400: proofDocumentResponses.genericError,
          404: proofDocumentResponses.genericError,
          429: proofDocumentResponses.genericError,
          500: proofDocumentResponses.internalServerError,
        },
      },
    },
    verifyProofDocumentController.handle,
  );
}

export { publicRoutes };
