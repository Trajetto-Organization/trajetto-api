import { inject, injectable } from "tsyringe";

import type { ClientVersion } from "@/shared/http/client-version";
import { logger } from "@/shared/logging/logger";
import { resolveTimeZone } from "@/shared/time/business-day";

import type { IDriverPauseRepository } from "../../repositories/IDriver-pause-repository";
import type { DriverPause, DriverPauseKind } from "../../dtos/driver-pause-dto";
import { enforcesPauseCooldown, pauseCooldown } from "../../rules/pause-rules";

import {
  PauseAlreadyOpenError,
  PauseCooldownError,
  PauseTooOldError,
  PauseTypeWrongCategoryError,
} from "../errors/driver-pause-errors";
import { assertPauseDriver, replayFor } from "../pause-ownership";
import {
  journeyRouteOrRefuse,
  resolvePauseType,
} from "../pause-type-and-journey";

const log = logger.child({ component: "driver-pause" });

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

  /**
   * The app build that sent it (x-trajetto-client-version), null when the
   * request does not say: from contract 5 on, a start inside the cooldown
   * is refused instead of recorded.
   */
  client?: ClientVersion | null;

  /** Sent by the app's offline queue (X-Client-Queued-At): never refused for the cooldown. */
  queued?: boolean;

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
 *
 * Owner, 05/11/2026: a new start tapped less than PAUSE_COOLDOWN_MINUTES
 * after the driver's previous pause ended is refused with 409
 * PAUSE_COOLDOWN, nothing written — only from a build that holds the wait
 * itself (contract 5 on) sending now (no X-Client-Queued-At). Anything else
 * inside the cooldown is recorded, with a warn line. Checked last, right
 * before the insert, so every refusal above wins over it.
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
    client = null,
    queued = false,
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

    // Measured from the tap, like the journey: the previous pause is the
    // one that ended before this start was tapped, never one sent later.
    const previous = await this.pauses.findLastEndedPause({
      businessId,
      driverId: driver,
      before: at,
    });
    const cooldown = pauseCooldown({
      lastEndedAt: previous?.ended_at ?? null,
      tap: at,
      now,
    });
    const enforced = enforcesPauseCooldown({
      clientContract: client?.contract,
      queued,
    });

    if (cooldown.blocks && enforced && previous?.ended_at) {
      await this.refuseInsideCooldown(
        businessId,
        driver,
        previous.ended_at,
        now,
      );
    }

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
      // Said once the pause is recorded, never for a start refused above or
      // a resend (answered by the replay lookup): tells when the builds that
      // do not hold the wait, and the queue's late starts, stop toggling.
      if (cooldown.blocks && previous) {
        log.warn(
          {
            pauseId: result.pause.id,
            previousPauseId: previous.id,
            businessId,
            driverId: driver,
            clientContract: client?.contract ?? null,
            queued,
          },
          "Pause started inside the cooldown by a queued resend or a build without the rule: recorded",
        );
      }

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

  /**
   * The cooldown's refusal, unless another pause of the driver is still
   * open: then the insert answers PAUSE_ALREADY_OPEN, the more fundamental
   * of the two (the app's state is stale, and it reads /current to learn the
   * open one). The zone is read only here, for the sentence.
   */
  private async refuseInsideCooldown(
    businessId: string,
    driverId: string,
    lastEndedAt: Date,
    now: Date,
  ): Promise<void> {
    if (await this.pauses.findOpenPause(businessId, driverId)) return;

    const zone = await this.pauses.timeZoneOf(businessId);

    throw new PauseCooldownError(lastEndedAt, resolveTimeZone(zone), now);
  }
}

export { StartDriverPauseUseCase };
export type { StartDriverPauseRequest, StartDriverPauseResult };
