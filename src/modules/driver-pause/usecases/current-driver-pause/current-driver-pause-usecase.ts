import { inject, injectable } from "tsyringe";

import { businessNotFound } from "@/shared/delivery/caller-not-found";
import {
  businessDateKey,
  businessDayRange,
  resolveTimeZone,
} from "@/shared/time/business-day";

import type { IDriverPauseRepository } from "../../repositories/IDriver-pause-repository";
import type { DriverPause } from "../../dtos/driver-pause-dto";

import { assertPauseDriver } from "../pause-ownership";

interface CurrentDriverPauseRequest {
  businessId: string;
  driverId: string | null | undefined;
  now?: Date;
}

interface CurrentDriverPause {
  timeZone: string;

  /** The company's today ("YYYY-MM-DD"). */
  day: string;

  /** The open pause, whenever it started; null when none is open. */
  open: DriverPause | null;

  /** Pauses that started today in the company's zone, oldest first. */
  today: DriverPause[];

  /**
   * Decision 14.4: whether a pause may start now (a route released or in
   * progress today). The app hides the action otherwise; an open pause can
   * always be ended.
   */
  pauseAllowed: boolean;

  /** The journey's route now; null outside a journey. */
  journeyRouteId: string | null;

  /** The type names of `open` and `today`, by id. */
  typeNames: Map<string, string>;
}

/**
 * What the app reads to know whether its driver is on a pause: after a
 * reinstall, a new phone or a logout, the local state is gone and only the
 * server knows the open pause (and its start key, which the end must name).
 */
@injectable()
class CurrentDriverPauseUseCase {
  constructor(
    @inject("DriverPauseRepository")
    private pauses: IDriverPauseRepository,
  ) {}

  async execute({
    businessId,
    driverId,
    now = new Date(),
  }: CurrentDriverPauseRequest): Promise<CurrentDriverPause> {
    const driver = assertPauseDriver(driverId);

    const zone = await this.pauses.timeZoneOf(businessId);

    if (zone === null) throw businessNotFound();

    const timeZone = resolveTimeZone(zone);

    const open = await this.pauses.findOpenPause(businessId, driver);
    const today = await this.pauses.listDriverPauses(
      businessId,
      driver,
      businessDayRange(now, timeZone),
    );

    const day = businessDateKey(now, timeZone);
    const journeyRouteId = await this.pauses.findJourneyRouteAt(businessId, driver, now, day);

    const typeNames = await this.pauses.pauseTypeNames(businessId, [
      ...(open ? [open.occurrenceTypeId] : []),
      ...today.map((pause) => pause.occurrenceTypeId),
    ]);

    return {
      timeZone,
      day,
      open,
      today,
      pauseAllowed: journeyRouteId !== null,
      journeyRouteId,
      typeNames,
    };
  }
}

export { CurrentDriverPauseUseCase };
export type { CurrentDriverPause, CurrentDriverPauseRequest };
