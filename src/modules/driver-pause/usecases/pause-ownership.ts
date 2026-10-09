import { permissionDenied } from "@/shared/errors/access-errors";
import { SubmissionOwnerMismatchError } from "@/shared/errors/submission-owner-mismatch-error";

import type { DriverPause } from "../dtos/driver-pause-dto";

/**
 * The session's driver, or a refusal. The route's permission table lets
 * office users with `delivery_manage:write` through; a pause, though, is the
 * driver's own record of the working day, never written by somebody else.
 */
function assertPauseDriver(driverId: string | null | undefined): string {
  if (!driverId) {
    throw permissionDenied("Somente o motorista registra as próprias pausas.");
  }

  return driverId;
}

/**
 * The answer to a resend: the pause the key already wrote, when it is this
 * driver's. Another driver's key is refused like every client key of the
 * product (ADR 0006): the pause is never handed over on a guessed id.
 */
function replayFor(
  pause: DriverPause,
  driverId: string,
): { pause: DriverPause; replayed: true } {
  if (pause.driverId !== driverId) throw new SubmissionOwnerMismatchError();

  return { pause, replayed: true };
}

export { assertPauseDriver, replayFor };
