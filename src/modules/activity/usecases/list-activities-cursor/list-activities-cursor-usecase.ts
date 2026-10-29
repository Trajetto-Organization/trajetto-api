import { inject, injectable } from "tsyringe";

import { IActivityRepository } from "../../repositories/IActivity-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { CursorPaginatedActivities } from "../../dtos/activity-dto";

interface ListActivitiesCursorRequest {
  userId: string;
  limit: number;
  cursor?: string;
  search?: string;
  periodDays: number;
  businessId?: string;
}

/**
 * The timeline feed: newest first, walked by cursor.
 *
 * Scope is resolved from the session, never from the request — a company
 * admin asking for another company's businessId simply gets their own, the
 * same rule the paginated listing follows.
 */
@injectable()
class ListActivitiesCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ActivityRepository")
    private activity: IActivityRepository,
  ) {}

  async execute({
    userId,
    limit,
    cursor,
    search,
    periodDays,
    businessId,
  }: ListActivitiesCursorRequest): Promise<CursorPaginatedActivities> {
    const currentUser = await this.user.findUserById(userId);

    if (!currentUser) {
      throw new ResourceNotFoundError();
    }

    return this.activity.listActivitiesWithCursor({
      currentUserRole: currentUser.role,
      businessId:
        currentUser.role === "MASTER"
          ? businessId
          : (currentUser.businessId ?? undefined),
      userId,
      limit,
      cursor,
      search,
      periodDays,
    });
  }
}

export { ListActivitiesCursorUseCase };
