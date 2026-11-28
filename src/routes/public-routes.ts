import { FastifyInstance } from "fastify";
import { z } from "zod";

import { VerifyProofDocumentController } from "@/modules/delivery/usecases/verify-proof-document/verify-proof-document-controller";

import { TrackDeliveryController } from "@/modules/delivery/usecases/track-delivery/track-delivery-controller";
import { OptOutTrackingController } from "@/modules/delivery/usecases/opt-out-tracking/opt-out-tracking-controller";
import { OpenProofLinkController } from "@/modules/integration/usecases/proof-link/open-proof-link-controller";

import { proofLinkParamsSchema } from "@/schemas/integration-schema";
import { PROOF_LINK_ROUTE } from "@/shared/integration/proof-link";
import { codedRefusal } from "./documentation/common-responses";

import {
  proofDocumentSchemas,
  proofDocumentResponses,
} from "./documentation/proof-document-documentation";

const verifyProofDocumentController = new VerifyProofDocumentController();

const trackDeliveryController = new TrackDeliveryController();
const optOutTrackingController = new OptOutTrackingController();
const openProofLinkController = new OpenProofLinkController();

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
        summary: "Confere um comprovante de entrega pelo código impresso",
        description:
          "Página pública do QR do comprovante. Não exige login: o código de verificação é a autorização. Responde se os bytes que estão no armazenamento AGORA ainda batem com o hash gravado quando o documento foi gerado — que é a razão de alguém escanear o código. `intact: false` com `storedSha256: null` significa arquivo ausente, não adulterado; os dois casos são diferentes e a página os distingue. Armazenamento que não respondeu não é arquivo ausente: responde 503 STORAGE_UNAVAILABLE com `retry-after`, e a conferência é repetida depois. O resumo é estreito de propósito: um link vazado mostra que UM comprovante é legítimo, não vira uma janela para a operação da transportadora.",
        params: proofDocumentSchemas.verifyProofParams,
        response: {
          200: proofDocumentResponses.proofVerification,
          400: proofDocumentResponses.genericError,
          404: proofDocumentResponses.genericError,
          429: proofDocumentResponses.genericError,
          500: proofDocumentResponses.internalServerError,
          503: proofDocumentResponses.verifyProofUnavailable,
        },
      },
    },
    verifyProofDocumentController.handle,
  );
  app.get(
    "/track/:token",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["public"],
        summary: "Acompanha uma entrega pelo link enviado ao destinatário",
        description:
          'Portal do destinatário. Sem login: o link é a autorização, e ele é encaminhado em grupo de família — por isso a resposta é escrita como uma SUBTRAÇÃO. Fica de fora tudo que é da operação: nome e telefone do motorista, placa, rota, outras paradas, embarcador e qualquer anotação interna. Sobra a resposta para a única pergunta que o destinatário tem, que é onde está a carga dele e quando chega. O tipo da ocorrência atravessa ("destinatário ausente" é o que ele precisa ouvir); a descrição livre não, porque é escrita por um motorista na rua, para o escritório.',
        params: proofDocumentSchemas.publicTokenParams,
        response: {
          200: proofDocumentResponses.tracking,
          400: proofDocumentResponses.genericError,
          404: proofDocumentResponses.genericError,
          429: proofDocumentResponses.genericError,
          500: proofDocumentResponses.internalServerError,
        },
      },
    },
    trackDeliveryController.handle,
  );

  app.post(
    "/track/:token/opt-out",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["public"],
        summary:
          "Deixa de receber mensagens desta transportadora neste telefone e e-mail",
        description:
          "Um clique a partir da própria mensagem, sem login — pedir que alguém se autentique para ser deixado em paz é como uma empresa ganha denúncia de spam. Para esta entrega e, na mesma transação, para o telefone (WhatsApp) e o e-mail do destinatário dentro da transportadora dona da entrega (plano de 02/11/2026, D38): nenhuma mensagem ao cliente dessa transportadora sai mais para eles, inclusive as que já estavam na fila; outras transportadoras não são afetadas. Repetir o clique não muda nada. Responde a mesma frase com token válido ou não: uma resposta diferente transformaria isto num oráculo de quais links existem.",
        params: proofDocumentSchemas.publicTokenParams,
        response: {
          200: proofDocumentResponses.optedOut,
          400: proofDocumentResponses.genericError,
          429: proofDocumentResponses.genericError,
          500: proofDocumentResponses.internalServerError,
        },
      },
    },
    optOutTrackingController.handle,
  );

  app.get(
    // The path proof_url points at, under this plugin's /public prefix.
    `${PROOF_LINK_ROUTE}/:token`,
    {
      config: {
        rateLimit: {
          // The verify-proof budget: a person or an ERP opening receipts one
          // by one fits; walking the 2^256 signature space does not.
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        tags: ["public"],
        summary: "Abre o comprovante pelo `proof_url` da API pública",
        description:
          "O `proof_url` que a API de integração e os webhooks entregam (plano de 02/11/2026, L7). Sem login nem chave: o link assinado é a autorização (link de portador, ADR 0009), preso à entrega e à empresa dona dela. Redireciona (302) para o PDF do comprovante, gerado na primeira abertura, por um endereço de curta duração. Vale enquanto o comprovante vale (`PROOF_VERIFICATION_TTL_DAYS`, contados da criação da entrega) e só para uma entrega que terminou (DELIVERED ou FAILED). Toda recusa — link malformado, adulterado, de outra empresa, vencido ou de uma entrega que não terminou — é o mesmo 404 PROOF_NOT_FOUND.",
        params: proofLinkParamsSchema,
        response: {
          302: z
            .null()
            .describe(
              "Redireciona para o PDF do comprovante (cabeçalho `Location`, endereço de curta duração).",
            ),
          400: proofDocumentResponses.genericError,
          404: proofDocumentResponses.genericError,
          429: proofDocumentResponses.genericError,
          500: proofDocumentResponses.internalServerError,
          503: codedRefusal(
            "O comprovante não pôde ser gerado agora; nada foi gravado. Transitório: espere o `retry-after` e repita.",
            [
              "PROOF_RENDER_BUSY",
              "PROOF_RENDER_TIMEOUT",
              "PROOF_RENDER_UNAVAILABLE",
              "PROOF_SIGNING_FAILED",
              "STORAGE_UNAVAILABLE",
              "SERVICE_UNAVAILABLE",
              "SERVICE_BUSY",
            ],
          ),
        },
      },
    },
    openProofLinkController.handle,
  );
}

export { publicRoutes };
