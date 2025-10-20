import { inject, injectable } from "tsyringe";

import { IActivityRepository } from "../../repositories/IActivity-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ListActivityProps } from "../../dtos/activity-dto";

import { AppError } from "@/shared/errors/AppError";

interface ListAllActivitiesRequest {
  userId: string;
  userRole: string;
  page: number;
  pageSize: number;
  search?: string;
}

@injectable()
class ListAllActivitiesUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("ActivityRepository")
    private activityRepository: IActivityRepository,
  ) {}

  async execute({
    userId,
    userRole,
    page,
    pageSize,
    search,
  }: ListAllActivitiesRequest): Promise<ListActivityProps> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      const result = await this.activityRepository.listAllActivities({
        page,
        pageSize,
        currentUserRole: userRole,
        businessId: user.businessId as string,
        search,
        userId: user.id,
      });

      return result;
    } catch (error) {
      throw new AppError("Erro ao listar todas as atividades", 500);
    }
  }
}

export { ListAllActivitiesUseCase };
