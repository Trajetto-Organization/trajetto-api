import { inject, injectable } from "tsyringe";

import { SubmissionOwnerMismatchError } from "@/shared/errors/submission-owner-mismatch-error";

import type { IDriverPauseRepository } from "../../repositories/IDriver-pause-repository";
import type { DriverPause, DriverPauseKind } from "../../dtos/driver-pause-dto";

import { pauseEndedAt, pauseStartedAtFromEnd } from "../../rules/pause-rules";

import {
  PauseAlreadyEndedError,
  PauseNotFoundError,
  PauseSubmissionReusedError,
  PauseTooOldError,
  PauseTypeWrongCategoryError,
} from "../errors/driver-pause-errors";
import { assertPauseDriver } from "../pause-ownership";
import { journeyRouteOrRefuse, resolvePauseType } from "../pause-type-and-journey";

interface EndDriverPauseRequest {
  businessId: string;
  driverId: string | null | undefined;

  /** Which pause: the key its start was sent with (the app has no pause id offline). */
  startSubmissionId: string;
  endSubmissionId: string;

  /** The corrected tap; null means the receipt time. */
  endedAt: Date | null;

  /** The end's tap is older than the offline horizon (isOccurredAtStale). */
  staleTap?: boolean;

  latitude?: number;
  longitude?: number;

  /**
   * The start gesture, repeated. When the end reaches us before its start
   * (the outbox moves on past an item that failed), the pause is created
   * already closed from this, and the late start then finds it.
   */
  start?: {
    kind?: DriverPauseKind;
    /** Decision 14.4: the PAUSE type of the start, when the app sent it. */
    occurrenceTypeId?: string;
    startedAt: Date | null;

    /** The start's tap is older than the offline horizon. */
    staleTap?: boolean;

    latitude?: number;
    longitude?: number;
    note?: string | null;
  };

  now?: Date;
}

interface EndDriverPauseResult {
  pause: DriverPause;

  /** The pause's type name by id (decision 14.4), for the view. */
  typeNames: Map<string, string>;

  /** True when this end key had already closed this pause (a resend). */
  replayed: boolean;
}

/**
 * The driver ends a pause (decision 6.1).
 *
 * Idempotent by `end_submission_id`: a resend answers the pause it already
 * closed. Safe against every order the outbox can deliver in: an end before
 * its start creates the pause closed; two ends racing close it once (the
 * write is conditional on the pause being open), and the loser learns which
 * key won. Creating the pause from a gesture tapped more than 7 days ago is
 * refused with PAUSE_TOO_OLD; closing one that exists never is.
 *
 * Decision 14.4: closing a pause that exists is never refused for want of a
 * route (an open pause must be able to close). An end that CREATES the pause
 * is a start too: outside a journey at the start's tap it is refused with
 * PAUSE_REQUIRES_ROUTE, nothing written.
 */
@injectable()
class EndDriverPauseUseCase {
  constructor(
    @inject("DriverPauseRepository")
    private pauses: IDriverPauseRepository,
  ) {}

  async execute(request: EndDriverPauseRequest): Promise<EndDriverPauseResult> {
    const result = await this.record(request);
    const typeNames = await this.pauses.pauseTypeNames(request.businessId, [
      result.pause.occurrenceTypeId,
    ]);

    return { ...result, typeNames };
  }

  private async record(
    request: EndDriverPauseRequest,
  ): Promise<Omit<EndDriverPauseResult, "typeNames">> {
    const driverId = assertPauseDriver(request.driverId);
    const { businessId, startSubmissionId, endSubmissionId } = request;
    const now = request.now ?? new Date();

    const closedByThisKey = await this.pauses.findByEndSubmission(
      businessId,
      endSubmissionId,
    );

    if (closedByThisKey) return this.replay(closedByThisKey, request, driverId);

    let pause = await this.pauses.findByStartSubmission(businessId, startSubmissionId);

    if (!pause) {
      if (!request.start) throw new PauseNotFoundError();

      // Creating the pause from a gesture past the horizon would date it by
      // its arrival: a pause the driver never took, today. An end of a pause
      // that exists is still taken below, stale or not, so the one open
      // slot is always freed (the report flags a pause closed that late).
      if (request.staleTap || request.start.staleTap) throw new PauseTooOldError();

      const created = await this.createClosed(request, driverId, now);

      if (created) return { pause: created, replayed: false };

      // The start (or a twin of this end) got there first; go on with it.
      const byEnd = await this.pauses.findByEndSubmission(businessId, endSubmissionId);

      if (byEnd) return this.replay(byEnd, request, driverId);

      pause = await this.pauses.findByStartSubmission(businessId, startSubmissionId);

      if (!pause) throw new PauseNotFoundError();
    }

    if (pause.driverId !== driverId) throw new SubmissionOwnerMismatchError();

    if (pause.ended_at) throw new PauseAlreadyEndedError();

    const result = await this.pauses.closePause({
      pauseId: pause.id,
      businessId,
      ended_at: pauseEndedAt(pause.started_at, request.endedAt, now),
      end_submission_id: endSubmissionId,
      end_latitude: request.latitude ?? null,
      end_longitude: request.longitude ?? null,
    });

    if (result.status === "closed") return { pause: result.pause, replayed: false };

    // Somebody closed it between the read and the write: the same key (a
    // racing resend) is this answer; another key is a real conflict.
    const byEnd = await this.pauses.findByEndSubmission(businessId, endSubmissionId);

    if (byEnd) return this.replay(byEnd, request, driverId);

    throw new PauseAlreadyEndedError();
  }

  /** The pause this end key already closed, when it is the same pause. */
  private replay(
    pause: DriverPause,
    request: EndDriverPauseRequest,
    driverId: string,
  ): Omit<EndDriverPauseResult, "typeNames"> {
    if (pause.driverId !== driverId) throw new SubmissionOwnerMismatchError();

    if (pause.start_submission_id !== request.startSubmissionId) {
      throw new PauseSubmissionReusedError();
    }

    return { pause, replayed: true };
  }

  /** The pause, created closed from the repeated start; null on a race. */
  private async createClosed(
    request: EndDriverPauseRequest,
    driverId: string,
    now: Date,
  ): Promise<DriverPause | null> {
    const start = request.start!;

    const endedAt = request.endedAt ?? now;
    const startedAt = pauseStartedAtFromEnd(start.startedAt, endedAt);

    const type = await resolvePauseType(
      this.pauses,
      request.businessId,
      start.occurrenceTypeId,
      start.kind,
    );

    const routeId = await journeyRouteOrRefuse(
      this.pauses,
      request.businessId,
      driverId,
      startedAt,
    );

    const result = await this.pauses.createPause({
      kind: type.pause_kind,
      occurrenceTypeId: type.id,
      started_at: startedAt,
      ended_at: endedAt,
      start_latitude: start.latitude ?? null,
      start_longitude: start.longitude ?? null,
      end_latitude: request.latitude ?? null,
      end_longitude: request.longitude ?? null,
      note: start.note ?? null,
      start_submission_id: request.startSubmissionId,
      end_submission_id: request.endSubmissionId,
      driverId,
      businessId: request.businessId,
      routeId,
    });

    // The type changed between the read and the insert: the start's 400.
    if (result.status === "invalid-type") throw new PauseTypeWrongCategoryError();

    return result.status === "created" ? result.pause : null;
  }
}

export { EndDriverPauseUseCase };
export type { EndDriverPauseRequest, EndDriverPauseResult };
