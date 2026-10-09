import { inject, injectable } from "tsyringe";

import { IUserRepository } from "../../repositories/IUser-repository";
import { ListUsersProps } from "../../dtos/user-dto";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";
import { permissionDenied } from "@/shared/errors/access-errors";

import type { SortOrder } from "@/shared/pagination/list-query";

import {
  summarizeUserList,
  type MasterSortKey,
  type UserAccess,
  type UserListSearchMeta,
  type UserTwoFactor,
} from "../list-users/user-list";

interface ListMasterUsersRequest {
  userId: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: MasterSortKey;
  order?: SortOrder;
  access?: UserAccess[];
  twoFactor?: UserTwoFactor[];
}

interface ListMasterUsersResponse {
  data: ListUsersProps[];
  total: number;
  /** Cards and filter options, counted over every master (decision 8.8). */
  searchMeta: UserListSearchMeta;
}

@injectable()
class ListMasterUsersUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    page,
    pageSize,
    search,
    sort,
    order,
    access,
    twoFactor,
  }: ListMasterUsersRequest): Promise<ListMasterUsersResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Checked here too, like its create/update/delete siblings: a job or
    // another route reaching this without verifyUserRole would list them all.
    if (findUser.role !== "MASTER") {
      throw permissionDenied("Apenas usuários Master podem listar usuários Master.");
    }

    try {
      const result = await this.user.listMasterUsers({
        page,
        pageSize,
        search,
        sort,
        order,
        access,
        twoFactor,
        currentUserId: findUser.id,
      });

      const { total, searchMeta } = summarizeUserList(
        result.groups,
        { access, twoFactor },
        result.profileNames,
        result.emailVerified,
      );

      return { data: result.data, total, searchMeta };
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de usuários!",
        500,
      );
    }
  }
}

export { ListMasterUsersUseCase };
