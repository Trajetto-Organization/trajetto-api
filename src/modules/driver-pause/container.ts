import { container } from "tsyringe";

import type { IDriverPauseRepository } from "./repositories/IDriver-pause-repository";
import { DriverPauseRepository } from "./repositories/driver-pause-repository";

/**
 * The module's repository in the container, registered by the module itself
 * (imported by its routes) so the shared registry needs no edit to add it.
 * Idempotent: a second import registers nothing new.
 */
if (!container.isRegistered("DriverPauseRepository")) {
  container.registerSingleton<IDriverPauseRepository>(
    "DriverPauseRepository",
    DriverPauseRepository,
  );
}
