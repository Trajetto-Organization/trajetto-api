import { inject, injectable } from "tsyringe";

import { IActivityRepository } from "../../repositories/IActivity-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ListActivityProps } from "../../dtos/activity-dto";

import { AppError } from "@/shared/errors/AppError";

interface ListRecentActivitiesRequest {
  userId: string;
  userRole: string;
  page: number;
  pageSize: number;
  search?: string;
}

@injectable()
class ListRecentActivitiesUseCase {
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
  }: ListRecentActivitiesRequest): Promise<ListActivityProps> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      const result = await this.activityRepository.listRecentActivities({
        page,
        pageSize,
        currentUserRole: userRole,
        businessId: user.businessId as string,
        search,
        userId: user.id,
      });

      return result;
    } catch (error) {
      throw new AppError("Erro ao listar as atividades recentes", 500);
    }
  }
}

export { ListRecentActivitiesUseCase };
