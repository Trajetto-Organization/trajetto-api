import { inject, injectable } from "tsyringe";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { ListSupplierProps } from "../../dtos/supplier-dto";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

@injectable()
class ListSupplierBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupplierRepository")
    private supplier: ISupplierRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    businessId: string,
  ): Promise<ListSupplierProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusinessById = await this.business.findBusinessById(businessId);

    if (!findBusinessById) {
      throw new BusinessNotFoundError();
    }

    try {
      const supplierList = await this.supplier.listSupplierBusiness({
        page,
        pageSize,
        businessId,
      });

      return supplierList;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de fornecedores por empresa!",
        500,
      );
    }
  }
}

export { ListSupplierBusinessUseCase };
