import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { User } from "@/modules/user/dtos/user-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

interface ChatScope {
  user: User;

  /** The company whose conversations are visible. */
  businessId: string;

  /** Set = a driver token: everything locks to their own thread. */
  driverId: string | null;
}

/**
 * Who is talking and inside which company. The enforceRequestedTenant hook
 * already refused a mismatched businessId for non-master users, so what is
 * left here is the MASTER's explicit choice — or the user's own company.
 */
async function resolveChatScope(
  userRepository: IUserRepository,
  userId: string,
  requestedBusinessId?: string,
): Promise<ChatScope> {
  const findUser = await userRepository.findUserById(userId);

  if (!findUser) {
    throw new ResourceNotFoundError();
  }

  const businessId =
    findUser.businessId ??
    (findUser.role === "MASTER" ? requestedBusinessId : undefined);

  if (!businessId) {
    throw new AppError(
      "Selecione uma empresa para usar o chat.",
      400,
      "CHAT_BUSINESS_REQUIRED",
    );
  }

  return {
    user: findUser,
    businessId,
    driverId: findUser.driverId ?? null,
  };
}

export { resolveChatScope };
export type { ChatScope };
