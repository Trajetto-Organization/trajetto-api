import type { AppError } from "@/shared/errors/AppError";

import { UserHasAssociatedServiceOrdersError } from "./usecases/errors/user-has-associated-service-orders-error";
import { UserHasAssociatedAccountPayablesError } from "./usecases/errors/user-has-associated-account-payables-error";
import { UserHasRecordsError } from "./usecases/errors/user-has-records-error";

/**
 * The rows that name a login on a RESTRICT key, and so keep it from being
 * deleted: the work it answers for (service orders, payables it registered)
 * and what the person did (delivery events — a tower decision among them —,
 * occurrences, proof reviews, chat messages, imports). Deleting the login
 * would erase who did what; revoking the access ends it and keeps the
 * history (docs/arquitetura.md, "Excluir x inativar/revogar").
 *
 * Fuelings, checklists, fines and routes are not here: they belong to the
 * Driver row, which outlives its login.
 */
interface UserHistoryCounts {
  /** service_order.responsibleUserId */
  serviceOrders: number;
  /** account_payable.registrationUserId */
  accountPayables: number;
  /** delivery_event.reportedById */
  deliveryEvents: number;
  /** delivery_occurrence.reportedById */
  occurrences: number;
  /** delivery_proof_audit.reviewedById */
  proofReviews: number;
  /** chat_message.senderId */
  chatMessages: number;
  /** import.performedById */
  imports: number;
}

const NO_USER_HISTORY: UserHistoryCounts = {
  serviceOrders: 0,
  accountPayables: 0,
  deliveryEvents: 0,
  occurrences: 0,
  proofReviews: 0,
  chatMessages: 0,
  imports: 0,
};

/** How each kind is named in a sentence, in the order the sentence lists them. */
const HISTORY_WORDS: Array<[keyof UserHistoryCounts, string]> = [
  ["serviceOrders", "ordem(ns) de serviço sob a responsabilidade dele"],
  ["accountPayables", "conta(s) a pagar registrada(s) por ele"],
  ["deliveryEvents", "evento(s) de entrega"],
  ["occurrences", "ocorrência(s)"],
  ["proofReviews", "revisão(ões) de comprovante"],
  ["chatMessages", "mensagem(ns) no chat"],
  ["imports", "importação(ões)"],
];

/**
 * The history as the refusals say it ("12 evento(s) de entrega e 3
 * mensagem(ns) no chat"), or null when the login has none.
 */
function describeUserHistory(counts: UserHistoryCounts): string | null {
  const parts = HISTORY_WORDS.filter(([kind]) => counts[kind] > 0).map(
    ([kind, words]) => `${counts[kind]} ${words}`,
  );

  if (parts.length === 0) return null;

  if (parts.length === 1) return parts[0];

  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

/**
 * The refusal for deleting a login with history, or null when it has none.
 * Service orders and payables first, with their own codes (the web and the
 * app read USER_HAS_SERVICE_ORDERS and USER_HAS_ACCOUNT_PAYABLES): handing
 * them to someone else is a way out the other kinds do not have. The use
 * cases ask it before deleting, and again when a row committed in between
 * meets the foreign key (P2003), so both answers are the same 409.
 */
function userHistoryRefusal(counts: UserHistoryCounts): AppError | null {
  if (counts.serviceOrders > 0) {
    return new UserHasAssociatedServiceOrdersError(counts.serviceOrders);
  }

  if (counts.accountPayables > 0) {
    return new UserHasAssociatedAccountPayablesError(counts.accountPayables);
  }

  const records = describeUserHistory(counts);

  return records ? new UserHasRecordsError(records) : null;
}

export {
  describeUserHistory,
  NO_USER_HISTORY,
  userHistoryRefusal,
  type UserHistoryCounts,
};
