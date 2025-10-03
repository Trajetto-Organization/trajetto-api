import { FastifyReply, FastifyRequest } from "fastify";
import { verify } from "jsonwebtoken";

import { UserRepository } from "../user/repositories/user-repository";
import { DriverRepository } from "../driver/repositories/driver-repository";

import auth from "@/config/auth";
import { AppError } from "@/shared/errors/AppError";

interface UserIdProps {
  sub: string;
}

async function ensureAuthenticated(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth_header = request.headers.authorization;

  if (!auth_header) {
    throw new AppError("Token ausente!");
  }

  const [, token] = auth_header.split(" "); // Bearer Token

  try {
    const { sub: user_id } = verify(token, auth.secret_token) as UserIdProps;

    const userTokenId = new UserRepository();
    const findUserById = await userTokenId.findUserById(user_id);

    if (!findUserById) {
      throw new AppError("Este usuário não existe!", 404);
    }

    if (findUserById.access_revoked) {
      throw new AppError(
        "Seu acesso foi revogado! Para acessar a plataforma novamente, por favor contate o administrador.",
        403,
      );
    }

    // If user has a driverId, fetch driver information
    let driverInfo = null;

    if (findUserById.driverId) {
      const driverRepository = new DriverRepository();
      const driver = await driverRepository.findDriverById(
        findUserById.driverId,
      );

      if (driver) {
        // Check if driver is inactive
        if (driver.status === "INACTIVE") {
          throw new AppError(
            "Seu cadastro como motorista está inativo! Para acessar a plataforma novamente, por favor contate o administrador.",
            403,
          );
        }

        driverInfo = {
          id: driver.id,
          branchId: driver.branchId as string,
        };
      }
    }

    request.user = {
      id: user_id,
      role: findUserById.role,
      profileAccess: findUserById.profileAccess,
      driverId: findUserById.driverId,
      driver: driverInfo,
    };
  } catch (error: any | undefined) {
    throw new AppError(`Invalid Token => ${error.message}`, 401);
  }
}

export { ensureAuthenticated };
