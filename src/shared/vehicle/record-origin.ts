import type { RecordOrigin } from "@prisma/client";

import { ZodError } from "zod";

/**
 * Where a refuelling or a checklist was made, as `created_from` stores it:
 * the web's "App"/"Web" badge and the activity trail's "Origem".
 *
 * A driver's record is the app's, whatever its body says. A driver login has
 * no create form on the web (its area there is read-only), so the app is the
 * only client it records from, and the body is that client's word, not a
 * fact: a refuelling that said WEB_DASHBOARD skipped the app's own rules (the
 * GPS point and the idempotency key) and was badged "Web" in the panel.
 *
 * Anybody else keeps what the body says. A body that names no origin (only
 * a checklist's can: the refuelling's schema requires one) is the app's when
 * it carries an idempotency key, and WEB_DASHBOARD, the column's default,
 * when it does not. On a checklist only the app sends a key (as a field or as
 * the Idempotency-Key header the controller copies in), and the build in
 * drivers' hands (mobile `main`, multipart) never names the origin, an
 * office user's checklist from it included; the web's form sends neither.
 * The same signal marked the app's older checklists
 * (20261105120100_vehicle_checklist_created_from_backfill).
 *
 * A driver is a BUSINESS_USER with a driver, as decidePermission reads it: an
 * admin linked to a driver still types records in the office, and forcing
 * the app's rules on that form would refuse every one of them.
 */
function resolveRecordOrigin(
  caller: { role: string; driverId?: string | null },
  sent: RecordOrigin | null | undefined,
  clientSubmissionId: string | null | undefined,
): RecordOrigin {
  if (caller.role === "BUSINESS_USER" && caller.driverId) return "MOBILE_APP";

  if (sent) return sent;

  return clientSubmissionId ? "MOBILE_APP" : "WEB_DASHBOARD";
}

/** The schema's sentence for an app refuelling sent without its key. */
const APP_SUBMISSION_KEY_REQUIRED =
  "A chave de idempotência é obrigatória para envios do aplicativo.";

/**
 * An app record carries its idempotency key: the app's outbox resends the
 * same submission until it is answered, and the key is what records it once.
 * createFuelSchema refuses MOBILE_APP without one; this is the same refusal,
 * a ZodError on the same field with the same sentence (400 VALIDATION_ERROR
 * with its `issues`), for the origin the server decided — a driver whose body
 * said WEB_DASHBOARD, and so carried no key, is refused too. Null when the
 * record may go on.
 */
function appSubmissionKeyRefusal(
  origin: RecordOrigin,
  clientSubmissionId: string | null | undefined,
): ZodError | null {
  if (origin !== "MOBILE_APP" || clientSubmissionId) return null;

  return new ZodError([
    {
      code: "custom",
      path: ["client_submission_id"],
      message: APP_SUBMISSION_KEY_REQUIRED,
    },
  ]);
}

export {
  APP_SUBMISSION_KEY_REQUIRED,
  appSubmissionKeyRefusal,
  resolveRecordOrigin,
};
