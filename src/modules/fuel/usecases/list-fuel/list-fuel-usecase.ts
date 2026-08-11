import { inject, injectable } from "tsyringe";

import { IFuelRepository } from "@/modules/fuel/repositories/IFuel-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { UploadService } from "@/shared/services/upload-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { ListFuelProps } from "../../dtos/fuel-dto";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class ListFuelUseCase {
  constructor(
    @inject("FuelRepository")
    private fuel: IFuelRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
  ): Promise<ListFuelProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const fuels = await this.fuel.listFuels({
        page,
        pageSize,
        businessId: findUser.businessId as string,
        currentUserRole: findUser.role,
        search,
      });

      return {
        ...fuels,
        // `getFileUrl` assina a URL de forma assincrona (AWS SDK v3), entao a
        // projecao precisa esperar todas as assinaturas.
        data: await Promise.all(
          fuels.data.map(async (fuel) => ({
            ...fuel,
            odometer_photo: fuel.odometer_photo
              ? await this.uploadService.getFileUrl(fuel.odometer_photo)
              : null,
          })),
        ),
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar o abastecimento! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListFuelUseCase };
