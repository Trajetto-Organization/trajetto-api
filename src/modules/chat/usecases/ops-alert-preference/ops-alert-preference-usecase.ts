import { inject, injectable } from "tsyringe";

import type { IOpsAlertPreferenceRepository } from "../../repositories/IOps-alert-preference-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

interface OpsAlertPreference {
  sound: boolean;
}

/**
 * The person's own switch for the alert sound (decision 14.6). Read and
 * written only for the requester: there is no id in the request to point at
 * someone else.
 */
@injectable()
class OpsAlertPreferenceUseCase {
  constructor(
    @inject("OpsAlertPreferenceRepository")
    private preferences: IOpsAlertPreferenceRepository,
  ) {}

  async get(userId: string): Promise<OpsAlertPreference> {
    const sound = await this.preferences.getSound(userId);

    if (sound === null) throw new ResourceNotFoundError();

    return { sound };
  }

  async update(
    userId: string,
    input: OpsAlertPreference,
  ): Promise<OpsAlertPreference> {
    const current = await this.preferences.getSound(userId);

    if (current === null) throw new ResourceNotFoundError();

    if (current !== input.sound)
      await this.preferences.setSound(userId, input.sound);

    return { sound: input.sound };
  }
}

export { OpsAlertPreferenceUseCase };
export type { OpsAlertPreference };
