import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { KanbanNotAllowedReorderColumnBusinessError } from "../errors/kanban-not-allowed-reorder-column-business-error";
import { KanbanOneOrMoreColumnNotBelongBusinessError } from "../errors/kanban-one-or-more-column-not-belong-business-error";

import { KanbanInvalidPositionError } from "../errors/kanban-invalid-position-error";

import { ReorderKanbanColumnsProps } from "../../dtos/kanban-dto";
import { AppError } from "@/shared/errors/AppError";

@injectable()
class ReorderKanbanColumnsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
  ) {}

  async execute(
    data: ReorderKanbanColumnsProps,
    userId: string,
  ): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(data.businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Verify user permissions
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== data.businessId) {
        throw new KanbanNotAllowedReorderColumnBusinessError();
      }
    }

    // Validate positions
    const positions = data.columns.map((col) => col.position);
    const uniquePositions = new Set(positions);

    if (positions.length !== uniquePositions.size) {
      throw new KanbanInvalidPositionError();
    }

    // Verify all columns belong to the business
    for (const column of data.columns) {
      const col = await this.kanban.findColumnById(column.id);
      if (!col || col.businessId !== data.businessId) {
        throw new KanbanOneOrMoreColumnNotBelongBusinessError();
      }
    }

    try {
      await this.kanban.reorderColumns(data);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar reordenar as colunas! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ReorderKanbanColumnsUseCase };
