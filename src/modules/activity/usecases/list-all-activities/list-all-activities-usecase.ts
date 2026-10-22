import { inject, injectable } from "tsyringe";

import { IActivityRepository } from "../../repositories/IActivity-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  ActivityListFilters,
  ListActivityProps,
} from "../../dtos/activity-dto";

import { AppError } from "@/shared/errors/AppError";

interface ListAllActivitiesRequest extends ActivityListFilters {
  userId: string;
  userRole: string;
  /** Honoured for the MASTER only; everyone else is pinned to their scope. */
  businessId?: string;
  page: number;
  pageSize: number;
  search?: string;
  order?: "asc" | "desc";
}

/**
 * The activity table. Scope comes from the session — a company admin asking
 * for another company's id still gets their own — and the filters narrow it
 * on the server, over the whole trail.
 */
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
    businessId,
    page,
    pageSize,
    search,
    statuses,
    types,
    actions,
    roles,
    order,
  }: ListAllActivitiesRequest): Promise<ListActivityProps> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      return await this.activityRepository.listAllActivities({
        page,
        pageSize,
        currentUserRole: userRole,
        businessId:
          userRole === "MASTER" ? businessId : (user.businessId ?? undefined),
        search,
        userId: user.id,
        statuses,
        types,
        actions,
        roles,
        order,
      });
    } catch (error) {
      throw new AppError("Erro ao listar todas as atividades", 500);
    }
  }
}

export { ListAllActivitiesUseCase };
