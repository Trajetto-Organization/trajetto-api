import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanColumn, UpdateKanbanColumnProps } from "../../dtos/kanban-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";
import { KanbanNotAllowedUpdateColumnBusinessError } from "../errors/kanban-not-allowed-update-column-business-error";

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

    // The path's board first: the answer to another company's board must not
    // depend on which column id was sent with it.
    if (findUser.role !== "MASTER" && findUser.businessId !== businessId) {
      throw new KanbanNotAllowedUpdateColumnBusinessError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findColumn = await this.kanban.findColumnById(columnId);

    // Missing and "on another board" answer alike (decision 11.3). Not even
    // the MASTER edits a column through another company's path.
    if (!findColumn || findColumn.businessId !== businessId) {
      throw new KanbanColumnNotFoundError();
    }

    try {
      return await this.kanban.updateColumn({ columnData, columnId });
    } catch (error) {
      // A concurrent delete: the repository says "not found".
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar atualizar a coluna! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateKanbanColumnUseCase };
