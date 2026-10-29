import { inject, injectable } from "tsyringe";

import type { IDriverPauseRepository } from "../../repositories/IDriver-pause-repository";
import type { DriverPause, DriverPauseKind } from "../../dtos/driver-pause-dto";

import {
  PauseAlreadyOpenError,
  PauseTooOldError,
  PauseTypeWrongCategoryError,
} from "../errors/driver-pause-errors";
import { assertPauseDriver, replayFor } from "../pause-ownership";
import {
  journeyRouteOrRefuse,
  resolvePauseType,
} from "../pause-type-and-journey";

interface StartDriverPauseRequest {
  businessId: string;

  /** The session's driver; null for anybody else, who is refused. */
  driverId: string | null | undefined;

  /**
   * The nature, as the installed app sends it alone (contract <= 2). With
   * occurrenceTypeId it is only a hint: the type's nature is recorded.
   */
  kind?: DriverPauseKind;

  /** Decision 14.4: the company's PAUSE type the driver chose. */
  occurrenceTypeId?: string;

  startSubmissionId: string;

  /** The corrected tap (resolveOccurredAt); null means the receipt time. */
  startedAt: Date | null;

  /**
   * The tap is older than the offline horizon (isOccurredAtStale): then
   * startedAt is null too, but "use the receipt time" would be a lie.
   */
  staleTap?: boolean;

  latitude?: number;
  longitude?: number;
  note?: string | null;

  /** The clock. Only tests pass it. */
  now?: Date;
}

interface StartDriverPauseResult {
  pause: DriverPause;

  /** The pause's type name by id (decision 14.4), for the view. */
  typeNames: Map<string, string>;

  /** True when the key had already started this pause (an outbox resend). */
  replayed: boolean;
}

/**
 * The driver starts a pause (decision 6.1).
 *
 * Idempotent by `start_submission_id`, the key the app mints once per gesture
 * and repeats on every resend: the same key answers the pause it already
 * started, open or closed, instead of a second one. At most one pause is open
 * per driver, which the partial unique index enforces under races; a start
 * with another key while one is open is refused with PAUSE_ALREADY_OPEN.
 * A new start tapped more than 7 days ago is refused with PAUSE_TOO_OLD.
 *
 * Decision 14.4: the pause is recorded under a PAUSE occurrence type (the
 * chosen one, or the default of `kind`'s nature for the installed app), and
 * only inside a journey — a route of the driver released or in progress that
 * day at the tap — or 409 PAUSE_REQUIRES_ROUTE with nothing written.
 */
@injectable()
class StartDriverPauseUseCase {
  constructor(
    @inject("DriverPauseRepository")
    private pauses: IDriverPauseRepository,
  ) {}

  async execute(
    request: StartDriverPauseRequest,
  ): Promise<StartDriverPauseResult> {
    const result = await this.record(request);

    return {
      ...result,
      typeNames: await this.namesOf(request.businessId, result.pause),
    };
  }

  private async namesOf(
    businessId: string,
    pause: DriverPause,
  ): Promise<Map<string, string>> {
    return this.pauses.pauseTypeNames(businessId, [pause.occurrenceTypeId]);
  }

  private async record({
    businessId,
    driverId,
    kind,
    occurrenceTypeId,
    startSubmissionId,
    startedAt,
    staleTap = false,
    latitude,
    longitude,
    note,
    now = new Date(),
  }: StartDriverPauseRequest): Promise<
    Omit<StartDriverPauseResult, "typeNames">
  > {
    const driver = assertPauseDriver(driverId);

    const earlier = await this.pauses.findByStartSubmission(
      businessId,
      startSubmissionId,
    );

    if (earlier) return replayFor(earlier, driver);

    // A start replayed past the horizon is not a start sent now: dated by
    // its arrival it would open a pause the driver never began and refuse
    // the real ones with PAUSE_ALREADY_OPEN. A resend of a start that did
    // get in is answered above, whatever its age.
    if (staleTap) throw new PauseTooOldError();

    const at = startedAt ?? now;

    const type = await resolvePauseType(
      this.pauses,
      businessId,
      occurrenceTypeId,
      kind,
    );

    // The journey at the moment of the tap, not at arrival: a pause replayed
    // hours later belongs to the route it was taken in, and one tapped with
    // no route released or running is refused.
    const routeId = await journeyRouteOrRefuse(
      this.pauses,
      businessId,
      driver,
      at,
    );

    const result = await this.pauses.createPause({
      kind: type.pause_kind,
      occurrenceTypeId: type.id,
      started_at: at,
      start_latitude: latitude ?? null,
      start_longitude: longitude ?? null,
      note: note ?? null,
      start_submission_id: startSubmissionId,
      driverId: driver,
      businessId,
      routeId,
    });

    if (result.status === "created") {
      return { pause: result.pause, replayed: false };
    }

    // A racing resend of the same gesture won the insert. Checked for
    // already-open too: whichever index Postgres reports first, the pause
    // that holds this key is the answer when it exists.
    const raced = await this.pauses.findByStartSubmission(
      businessId,
      startSubmissionId,
    );

    if (raced) return replayFor(raced, driver);

    if (result.status === "already-open") throw new PauseAlreadyOpenError();

    // The type was checked above; it vanished or changed in between.
    if (result.status === "invalid-type")
      throw new PauseTypeWrongCategoryError();

    throw new Error(`Unexpected pause conflict: ${result.status}`);
  }
}

export { StartDriverPauseUseCase };
export type { StartDriverPauseRequest, StartDriverPauseResult };
