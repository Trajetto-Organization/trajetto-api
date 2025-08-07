import { inject, injectable } from "tsyringe";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { ListSupplierProps } from "../../dtos/supplier-dto";

@injectable()
class ListSupplierUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupplierRepository")
    private supplier: ISupplierRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListSupplierProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const supplierList = await this.supplier.listAllSuppliers({
        page,
        pageSize,
        currentUserRole: findUser.role,
        businessId: findUser.businessId as string,
        search,
      });

      return supplierList;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os fornecedores! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListSupplierUseCase };
