import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { KanbanColumn } from "../../dtos/kanban-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";
import { KanbanNotAllowedDeleteColumnBusinessError } from "../errors/kanban-not-allowed-delete-column-business-error";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class DeleteKanbanColumnUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
  ) {}

  async execute(
    columnId: string,
    businessId: string,
    userId: string,
  ): Promise<KanbanColumn> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // The path's board first, whatever column id came with it.
    if (findUser.role !== "MASTER" && findUser.businessId !== businessId) {
      throw new KanbanNotAllowedDeleteColumnBusinessError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findColumn = await this.kanban.findColumnById(columnId);

    // Missing and "on another board" answer alike (decision 11.3).
    if (!findColumn || findColumn.businessId !== businessId) {
      throw new KanbanColumnNotFoundError();
    }

    try {
      return await this.kanban.deleteColumn(columnId);
    } catch (error) {
      // Deleted meanwhile by someone else: the repository says "not found".
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar excluir a coluna! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteKanbanColumnUseCase };
