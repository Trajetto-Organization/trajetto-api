import { container } from "tsyringe";

import type { IPushDeviceTokenRepository } from "./repositories/IPush-device-token-repository";
import { PushDeviceTokenRepository } from "./repositories/push-device-token-repository";

/**
 * Registered by the module itself (imported by the push-token use cases), so
 * the shared registry needs no edit. Idempotent: a second import is a no-op.
 */
if (!container.isRegistered("PushDeviceTokenRepository")) {
  container.registerSingleton<IPushDeviceTokenRepository>(
    "PushDeviceTokenRepository",
    PushDeviceTokenRepository,
  );
}
