import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ITrafficViolationCodeRepository } from "../../repositories/ITraffic-violation-code-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { ListTrafficViolationCodeProps } from "../../dtos/traffic-violation-code-dto";

@injectable()
class ListTrafficViolationCodeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("TrafficViolationCodeRepository")
    private trafficViolationCode: ITrafficViolationCodeRepository,
  ) {}

  async execute(
    userId: string,
    page: number,
    pageSize: number,
    search?: string,
    gravity?: "LIGHT" | "MEDIUM" | "SERIOUS" | "VERY_SERIOUS" | "NO_POINTS",
    violatorType?: string,
  ): Promise<ListTrafficViolationCodeProps> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      const trafficViolationCodes =
        await this.trafficViolationCode.listTrafficViolationCodes({
          page,
          pageSize,
          search,
          gravity,
          violatorType,
        });

      return trafficViolationCodes;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar listar os códigos de infrações! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ListTrafficViolationCodeUseCase };
