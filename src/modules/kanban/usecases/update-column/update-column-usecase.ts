import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanColumn, UpdateKanbanColumnProps } from "../../dtos/kanban-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";
import { KanbanColumnNotBelongBusinessError } from "../errors/kanban-column-not-belong-business-error";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class UpdateKanbanColumnUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
  ) {}

  async execute(
    columnData: UpdateKanbanColumnProps,
    columnId: string,
    businessId: string,
    userId: string,
  ): Promise<KanbanColumn> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findColumn = await this.kanban.findColumnById(columnId);

    if (!findColumn) {
      throw new KanbanColumnNotFoundError();
    }

    if (findColumn.businessId !== businessId && findUser.role !== "MASTER") {
      throw new KanbanColumnNotBelongBusinessError();
    }

    // Verify user permissions
    if (
      findUser.role === "BUSINESS_ADMIN" ||
      findUser.role === "BUSINESS_USER"
    ) {
      if (findUser.businessId !== businessId) {
        throw new AppError(
          "Você não tem permissão para editar colunas nesta empresa.",
          403,
        );
      }
    }

    try {
      const updatedColumn = await this.kanban.updateColumn({
        columnData,
        columnId,
      });

      return updatedColumn;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a coluna! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateKanbanColumnUseCase };
