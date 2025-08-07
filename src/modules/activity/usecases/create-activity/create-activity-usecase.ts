import { inject, injectable } from "tsyringe";
import { IActivityRepository } from "../../repositories/IActivity-repository";

import { Activity, CreateActivityProps } from "../../dtos/activity-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class CreateActivityUseCase {
  constructor(
    @inject("ActivityRepository")
    private activityRepository: IActivityRepository,
  ) {}

  async execute(activityData: CreateActivityProps): Promise<Activity> {
    try {
      const activity =
        await this.activityRepository.createActivity(activityData);
      return activity;
    } catch (error) {
      throw new AppError("Erro ao registrar atividade", 500);
    }
  }
}

export { CreateActivityUseCase };
