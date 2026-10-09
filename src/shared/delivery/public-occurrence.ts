import type { OccurrenceAuthorizationStatus } from "@prisma/client";

/**
 * The authorization states of an occurrence that may leave the company: the
 * tracking page and the proof PDF (decision 6.3). A request still waiting for
 * the tower, denied, or closed without a decision never happened to the
 * delivery, so the person waiting for it must not read it as a fact.
 */
const PUBLIC_AUTHORIZATION_STATUSES: OccurrenceAuthorizationStatus[] = [
  "NOT_REQUIRED",
  "APPROVED",
];

export { PUBLIC_AUTHORIZATION_STATUSES };
