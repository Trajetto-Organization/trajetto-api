import {
  formatOccurrenceAnswer,
  readFormFields,
} from "@/modules/occurrence-type/form/occurrence-form-rules";

import type { DeliveryOccurrenceAuthorizationRequestedPayload } from "@/shared/notifications/notification-types";

/**
 * The answers as the tower reads them: "Rótulo: valor", in the form's order.
 * An answer whose field left the form keeps its key as the label rather than
 * vanishing from the notice.
 */
function labelledAnswers(
  storedFields: unknown,
  answers: unknown,
): Array<{ label: string; value: string }> {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return [];

  const given = answers as Record<string, string | number | boolean>;
  const fields = readFormFields(storedFields) ?? [];

  const known = fields
    .filter((field) => Object.prototype.hasOwnProperty.call(given, field.key))
    .map((field) => ({
      label: field.label,
      value: formatOccurrenceAnswer(field, given[field.key]),
    }));

  const orphans = Object.keys(given)
    .filter((key) => !fields.some((field) => field.key === key))
    .map((key) => ({ label: key, value: formatOccurrenceAnswer(undefined, given[key]) }));

  return [...known, ...orphans];
}

/** The request as the operators are told about it (and, later, escalated). */
function authorizationRequestedPayload(input: {
  occurrenceId: string;
  deliveryId: string;
  businessId: string;
  recipientName: string;
  occurrenceTypeName: string;
  blocksDelivery: boolean;
  description: string | null;
  reporterName: string;
  /** False for a request filed from the panel by someone who cannot decide it. */
  fromDriver: boolean;
  photosCount: number;
  formFields: unknown;
  answers: unknown;
  requestedAt: Date;
  /** Decision 14.3: a delivery request reads as one. */
  category?: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
}): DeliveryOccurrenceAuthorizationRequestedPayload {
  return {
    occurrenceId: input.occurrenceId,
    deliveryId: input.deliveryId,
    businessId: input.businessId,
    recipientName: input.recipientName,
    occurrenceTypeName: input.occurrenceTypeName,
    blocksDelivery: input.blocksDelivery,
    description: input.description,
    reporterName: input.reporterName,
    fromDriver: input.fromDriver,
    photosCount: input.photosCount,
    answers: labelledAnswers(input.formFields, input.answers),
    requestedAt: input.requestedAt.toISOString(),
    category: input.category === "DELIVERED" ? "DELIVERED" : "NOT_DELIVERED",
  };
}

export { authorizationRequestedPayload, labelledAnswers };
