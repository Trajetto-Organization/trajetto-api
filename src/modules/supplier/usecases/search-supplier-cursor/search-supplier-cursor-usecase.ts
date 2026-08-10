import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ISupplierRepository } from "../../repositories/ISupplier-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { CursorPaginatedSupplier } from "../../dtos/supplier-dto";
import { AppError } from "@/shared/errors/AppError";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

interface SearchSupplierWithCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  businessId: string;
}

@injectable()
class SearchSupplierCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("SupplierRepository")
    private supplier: ISupplierRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    businessId,
  }: SearchSupplierWithCursorRequest): Promise<CursorPaginatedSupplier> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    try {
      const result = await this.supplier.searchSupplierWithCursor({
        limit,
        cursor,
        businessId,
      });

      return result;
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de fornecedores por empresa!",
        500,
      );
    }
  }
}

export { SearchSupplierCursorUseCase };
