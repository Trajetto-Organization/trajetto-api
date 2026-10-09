/**
 * Who hears that an analysis ended (AI-6).
 *
 * The full `aiVerification` progress goes to whoever requested it — almost
 * always the driver, on the app. The admin looking at that fuelling or
 * checklist on the web never heard anything, and the dialog's durable
 * fallback polled "Analisando 8 de 8" forever. So a terminal step also goes
 * out as a HINT to the screens of the company: record kind and id, no reading,
 * no status. Like `catalogChanged`, the clients refetch through the API,
 * which re-checks permissions, and a lost hint only costs a "Revalidar".
 *
 * The proof's hint goes to the operations room (delivery staff: the review
 * queue's audience); a fuelling's or a checklist's to the company room, where
 * the fleet screens are. Both also reach the MASTER sockets, which belong to
 * no company. Only terminal steps: a checklist of eight photos would
 * otherwise broadcast ten frames to every socket of the tenant.
 */

const AI_ANALYSIS_CHANGED_EVENT = "aiAnalysisChanged";

const TERMINAL_STEPS = new Set(["completed", "skipped"]);

type AIHintAudience = "operations" | "business";

interface AIAnalysisChangedEvent {
  businessId: string;
  recordType: "fuel" | "checklist" | "proof";
  recordId: string;
}

function aiAnalysisHint(
  event: unknown,
): { audience: AIHintAudience; payload: AIAnalysisChangedEvent } | null {
  if (!event || typeof event !== "object") return null;

  const { step, businessId, recordType, recordId } = event as Record<
    string,
    unknown
  >;

  if (typeof step !== "string" || !TERMINAL_STEPS.has(step)) return null;
  if (typeof businessId !== "string" || businessId.length === 0) return null;
  if (typeof recordId !== "string" || recordId.length === 0) return null;

  if (
    recordType !== "fuel" &&
    recordType !== "checklist" &&
    recordType !== "proof"
  ) {
    return null;
  }

  return {
    audience: recordType === "proof" ? "operations" : "business",
    payload: { businessId, recordType, recordId },
  };
}

export { AI_ANALYSIS_CHANGED_EVENT, aiAnalysisHint };
export type { AIAnalysisChangedEvent, AIHintAudience };
