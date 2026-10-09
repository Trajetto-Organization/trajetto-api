import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ReportDeliveryOccurrenceUseCase } from "./report-delivery-occurrence-usecase";
import {
  OccurrenceFormInvalidError,
  OccurrenceFormNeedsAppUpdateError,
  OccurrenceFormOutdatedError,
} from "./occurrence-report-errors";

import { reportDeliveryOccurrenceSchema } from "@/schemas/report-delivery-occurrence-schema";
import { submissionKeyOf } from "@/shared/http/submission-key";
import {
  CLIENT_SENT_AT_HEADER,
  resolveOccurredAt,
} from "@/shared/delivery/occurred-at";
import { proofCaptureOf } from "@/shared/delivery/proof-capture";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

/** What the driver reads after sending (the app shows it as the toast). */
const MESSAGES = {
  PENDING: "Ocorrência registrada. Aguardando autorização da torre.",
  SUPERSEDED:
    "Ocorrência registrada. A entrega já estava resolvida, então não há o que autorizar.",
  default: "Ocorrência registrada com sucesso!",
} as const;

/** The same three moments for a DELIVERED type (decision 14.3). */
const DELIVERED_MESSAGES = {
  PENDING: "Entrega registrada. Aguardando autorização da torre.",
  SUPERSEDED:
    "Entrega registrada. A entrega já estava resolvida, então não há o que autorizar.",
  default: "Entrega registrada com sucesso!",
} as const;

class ReportDeliveryOccurrenceController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const {
      occurrenceTypeId,
      description,
      latitude,
      longitude,
      photos,
      client_submission_id,
      occurred_at,
      form_answers,
      form_version,
      receipt_photo,
      signature,
      received_by,
      device_precheck,
      photo_taken_at,
      device_id,
    } = reportDeliveryOccurrenceSchema.parse(request.body);

    // The report in the street, moved onto the server's clock by the phone's
    // own send stamp. The web sends neither and gets the receipt time.
    const occurredAt = resolveOccurredAt({
      occurredAt: occurred_at,
      clientSentAt: request.headers[CLIENT_SENT_AT_HEADER],
    });

    // The key is optional here (the web reports occurrences without one), so
    // the Idempotency-Key header counts too, as it already did for fuelings
    // and checklists: a resend that carried the key only in the header used
    // to record a second occurrence every time.
    const submissionId =
      client_submission_id ??
      submissionKeyOf(undefined, request.headers["idempotency-key"]);

    const reportDeliveryOccurrenceUseCase = container.resolve(
      ReportDeliveryOccurrenceUseCase,
    );

    try {
      const result = await reportDeliveryOccurrenceUseCase.execute({
        userId: id,
        businessId,
        deliveryId,
        occurrenceTypeId,
        description,
        latitude,
        longitude,
        photos,
        client_submission_id: submissionId,
        occurredAt,
        form_answers,
        form_version,
        receipt_photo,
        signature,
        received_by,
        device_precheck,
        // The photo stamp and the phone, for the PROOF a DELIVERED type
        // writes (decision 14.8); unused by other categories.
        capture: proofCaptureOf({
          headers: request.headers,
          photoTakenAt: photo_taken_at,
          deviceId: device_id,
          occurredAt,
        }),
      });

      const messages = result.category === "DELIVERED" ? DELIVERED_MESSAGES : MESSAGES;

      const message =
        result.authorization_status === "PENDING" ||
        result.authorization_status === "SUPERSEDED"
          ? messages[result.authorization_status]
          : messages.default;

      return reply.status(201).send({
        message,
        data: {
          id: result.id,
          authorization_status: result.authorization_status,
          replayed: result.replayed,
          category: result.category,
          delivery_status: result.delivery_status,
          // Decision 14.5: the support ticket of this occurrence, if any.
          ticket: result.ticket ?? null,
        },
      });
    } catch (error) {
      // The two form refusals carry more than a sentence: which field, and
      // for a stale form, the current one. Everything else is an AppError the
      // global handler answers with its status and code.
      if (error instanceof OccurrenceFormOutdatedError) {
        return reply.status(409).send({
          code: error.code,
          message: error.message,
          field_errors: error.fieldErrors,
          form_fields: error.formFields,
          form_version: error.formVersion,
        });
      }

      if (error instanceof OccurrenceFormNeedsAppUpdateError) {
        return reply.status(400).send({
          code: error.code,
          message: error.message,
          field_errors: error.fieldErrors,
          form_fields: error.formFields,
          form_version: error.formVersion,
        });
      }

      if (error instanceof OccurrenceFormInvalidError) {
        return reply.status(400).send({
          code: error.code,
          message: error.message,
          field_errors: error.fieldErrors,
        });
      }

      throw error;
    }
  }
}

export { ReportDeliveryOccurrenceController };
