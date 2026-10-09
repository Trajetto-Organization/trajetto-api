import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { RegisterDeliveryProofUseCase } from "./register-delivery-proof-usecase";
import { LegacyProofNeedsAppUpdateError } from "../report-delivery-occurrence/occurrence-report-errors";

import { deliveryProofSchema } from "@/schemas/delivery-proof-schema";
import {
  CLIENT_SENT_AT_HEADER,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";
import { proofCaptureOf } from "@/shared/delivery/proof-capture";
import { clientVersionForLog } from "@/shared/http/client-version";
import { urlForLog } from "@/shared/logging/redact-url";
import { countLegacyContractUse } from "@/shared/http/legacy-contract-usage";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

/**
 * The installed app's proof route (contract <= 2), kept as an adapter onto
 * the DELIVERED occurrence report (decision 14.3; design §4.7). Route,
 * body and success answer are unchanged for that build.
 */
class RegisterDeliveryProofController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const {
      client_submission_id,
      photo,
      signature,
      received_by,
      latitude,
      longitude,
      occurred_at,
      device_precheck,
      photo_taken_at,
      device_id,
    } = deliveryProofSchema.parse(request.body);

    // Every use, so "14 days without one" can be read from the logs.
    countLegacyContractUse("legacy_proof_adapter");
    request.log.info(
      {
        event: "legacy_proof_adapter",
        url: urlForLog(request),
        client: clientVersionForLog(request),
        businessId,
      },
      "Deprecated contract: proof route of an app without delivery types",
    );

    // The signature on the receipt, moved onto the server's clock by the
    // phone's own send stamp.
    const occurredAt = resolveOccurredAt({
      occurredAt: occurred_at,
      clientSentAt: request.headers[CLIENT_SENT_AT_HEADER],
    });

    const registerDeliveryProofUseCase = container.resolve(
      RegisterDeliveryProofUseCase,
    );

    try {
      const result = await registerDeliveryProofUseCase.execute({
        userId: id,
        businessId,
        deliveryId,
        client_submission_id,
        photo,
        signature,
        received_by,
        latitude,
        longitude,
        occurredAt,
        device_precheck,
        capture: proofCaptureOf({
          headers: request.headers,
          photoTakenAt: photo_taken_at,
          deviceId: device_id,
          occurredAt,
        }),
      });

      // The default type may ask the tower (design §4.7): that build already
      // shows the request on the delivery's card.
      return reply.status(201).send({
        message:
          result.authorization_status === "PENDING"
            ? "Entrega registrada. Aguardando autorização da torre."
            : "Entrega comprovada com sucesso!",
      });
    } catch (error) {
      if (error instanceof LegacyProofNeedsAppUpdateError) {
        return reply.header("x-error-code", error.code).status(400).send({
          code: error.code,
          message: error.message,
          missing: error.missing,
        });
      }

      throw error;
    }
  }
}

export { RegisterDeliveryProofController };
