import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ITrafficViolationCodeRepository } from "../../repositories/ITraffic-violation-code-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { CursorPaginatedTrafficViolationCode } from "../../dtos/traffic-violation-code-dto";

interface SearchTrafficViolationCodeCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  /** What the person typed in the picker, trimmed by the schema. */
  search?: string;
}

@injectable()
class SearchTrafficViolationCodeCursorUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("TrafficViolationCodeRepository")
    private trafficViolationCode: ITrafficViolationCodeRepository,
  ) {}

  async execute({
    userId,
    limit = 10,
    cursor,
    search,
  }: SearchTrafficViolationCodeCursorRequest): Promise<CursorPaginatedTrafficViolationCode> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      return await this.trafficViolationCode.searchTrafficViolationCodeWithCursor(
        { limit, cursor, search },
      );
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de códigos de infração!",
        500,
      );
    }
  }
}

export { SearchTrafficViolationCodeCursorUseCase };
