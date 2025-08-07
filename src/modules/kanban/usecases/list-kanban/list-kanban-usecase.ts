import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { ListKanbanColumnProps } from "../../dtos/kanban-dto";
import { AppError } from "@/shared/errors/AppError";

interface ListKanbanParams {
  businessId: string;
  userId: string;
  page?: number;
  pageSize?: number;
  search?: string;
}

@injectable()
class ListKanbanUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
  ) {}

  /**
   * Check if the user has read permission for the kanban
   */
  private hasKanbanReadPermission(user: any): boolean {
    // MASTER and BUSINESS_ADMIN always have full access
    if (user.role === "MASTER" || user.role === "BUSINESS_ADMIN") {
      return true;
    }

    // For BUSINESS_USER, check the specific permissions.
    if (user.role === "BUSINESS_USER" && user.profileAccess?.permissions) {
      const kanbanPermission = user.profileAccess.permissions.find(
        (perm: any) => perm.permissionKey === "kanban_manage",
      );

      return kanbanPermission?.canRead === true;
    }

    return false;
  }

  async execute({
    businessId,
    userId,
    page,
    pageSize,
    search,
  }: ListKanbanParams): Promise<ListKanbanColumnProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Check if the user belongs to the company (maintain the original logic)
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== businessId) {
        throw new AppError(
          "Você não tem permissão para visualizar o kanban desta empresa.",
          403,
        );
      }
    }

    // Check if there is permission for full reading
    const hasFullAccess = this.hasKanbanReadPermission(findUser);

    try {
      const columns = await this.kanban.findColumnsByBusinessId(
        businessId,
        true, // includeCards
        page,
        pageSize,
        search,
        hasFullAccess ? undefined : userId, // If you do not have full access, filter by user.
      );

      return columns;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar o kanban! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListKanbanUseCase };
