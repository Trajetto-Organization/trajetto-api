import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { KanbanColumn, CreateKanbanColumnProps } from "../../dtos/kanban-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { KanbanNotAllowedCreateColumnBusinessError } from "../errors/kanban-not-allowed-create-column-business-error";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class CreateKanbanColumnUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
  ) {}

  async execute(
    columnData: CreateKanbanColumnProps,
    userId: string,
  ): Promise<KanbanColumn> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      columnData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Verify user permissions
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== columnData.businessId) {
        throw new KanbanNotAllowedCreateColumnBusinessError();
      }
    }

    try {
      const column = await this.kanban.createColumn(columnData);
      return column;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar a coluna! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateKanbanColumnUseCase };
