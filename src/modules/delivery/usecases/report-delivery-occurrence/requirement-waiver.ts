import type {
  MissingRequirement,
  MissingRequirementCode,
} from "@/modules/occurrence-type/rules/occurrence-category-rules";

/**
 * A driver's report the company's requirements changed under (K2, decision
 * D29).
 *
 * The app checks the type's requirements before it queues a report, against
 * the type it has cached. A report tapped offline and sent after the company
 * switched a requirement on was refused against the type as it is NOW: a 400
 * the outbox files as a permanent failure, for a report that obeyed every
 * rule there was when it was made. Like a proof tapped before its type was
 * deactivated (deactivated_at), a tap before `requirements_changed_at` keeps
 * the rules it was made under. The server cannot tell which flags were the
 * new ones, so it accepts what was sent and flags the report for review.
 */

/** Whether the driver's tap came before the type's last requirements change. */
function tappedBeforeRequirementsChanged(
  occurredAt: Date | null | undefined,
  requirementsChangedAt: Date | null | undefined,
): boolean {
  return (
    occurredAt instanceof Date &&
    requirementsChangedAt instanceof Date &&
    occurredAt.getTime() < requirementsChangedAt.getTime()
  );
}

const WAIVED_LABELS: Record<MissingRequirementCode, string> = {
  OCCURRENCE_RECEIPT_PHOTO_REQUIRED: "a foto do canhoto",
  OCCURRENCE_SIGNATURE_REQUIRED: "a assinatura de quem recebeu",
  OCCURRENCE_PHOTO_REQUIRED: "a foto anexada",
};

/** "a, b e c", in the API's order of the checks. */
function joinPt(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** The trail's flag: what the report went without, and why it stands. */
function waivedRequirementsNote(
  typeName: string,
  waived: MissingRequirement[],
): string {
  return (
    `Aceita sem ${joinPt(waived.map((item) => WAIVED_LABELS[item.code]))}: ` +
    `o motorista registrou no aplicativo antes de o tipo "${typeName}" ` +
    "passar a exigir. Confira o registro."
  );
}

export { tappedBeforeRequirementsChanged, waivedRequirementsNote };
